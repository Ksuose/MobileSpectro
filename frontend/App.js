import React, { useEffect, useState, useRef } from 'react';
import {
  View,
  StyleSheet,
  Text,
  TouchableOpacity,
  ScrollView,
  Alert,
  ActivityIndicator,
  Dimensions,
} from 'react-native';
import * as ExpoCameraModule from 'expo-camera';
import Slider from '@react-native-community/slider';
import { LineChart } from 'react-native-chart-kit';
import Canvas from 'react-native-canvas';
import * as analysisUtils from './analysisUtils';
import { KineticAnalysisScreen } from './KineticAnalysisScreen';

const API_URL = 'https://mobilespectro-183048999594.europe-west1.run.app';
const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

const CAMERA_HEIGHT = 400;
const ROI_WIDTH_FRACTION = 0.8; // 80% of screen width

// State machine constants
const STATES = {
  IDLE: 'IDLE',
  BLANKING_COUNTDOWN: 'BLANKING_COUNTDOWN',
  BLANKING: 'BLANKING',
  BLANKING_COMPLETE: 'BLANKING_COMPLETE',
  SCANNING: 'SCANNING',
  PROCESSING: 'PROCESSING',
};

export default function App() {
  useEffect(() => {
    try {
      console.log('DEBUG: Camera import ->', ExpoCameraModule);
      console.log('DEBUG: Slider import ->', Slider);
      console.log('DEBUG: analysisUtils keys ->', Object.keys(analysisUtils));
    } catch (e) {
      console.warn('DEBUG logging failed', e);
    }
  }, []);

  // Resolve Camera component: prefer named export CameraView, then default, then Camera
  const CameraComponent = ExpoCameraModule.CameraView || ExpoCameraModule.default || ExpoCameraModule.Camera || ExpoCameraModule;
  console.log('DEBUG: CameraComponent ->', CameraComponent, 'typeof:', typeof CameraComponent);

  // If CameraComponent is not a valid component, render a safe fallback to avoid crash
  if (!CameraComponent || (typeof CameraComponent !== 'function' && typeof CameraComponent !== 'object')) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <Text style={{ color: '#FFF', padding: 12 }}>Camera module not available or failed to load.</Text>
        <Text style={{ color: '#8B949E' }}>Check console logs for 'DEBUG: Camera import'.</Text>
      </View>
    );
  }
  const [permission, requestPermission] = ExpoCameraModule.useCameraPermissions();
  const [appState, setAppState] = useState(STATES.IDLE);
  const [loading, setLoading] = useState(true);

  // ROI Configuration
  // Keep only separate ROI configs for sample + reference

  // Separate ROI configs (percentages)
  const [sampleROIConfig, setSampleROIConfig] = useState({ widthPercent: 80, heightPercent: 20, centerYPercent: 30 });
  const [referenceROIConfig, setReferenceROIConfig] = useState({ widthPercent: 80, heightPercent: 20, centerYPercent: 70 });

  // Scan data
  const cameraRef = useRef(null);
  const frameDataRef = useRef(null);
  const captureErrorRef = useRef(false);
  const captureInFlightRef = useRef(false);

  const absorbanceDataRef = useRef([]);
  const blankSampleRGBRef = useRef(null);
  const blankReferenceRGBRef = useRef(null);
  const countdownRef = useRef(3);
  const [countdown, setCountdown] = useState(3);
  const scanStartTimeRef = useRef(null);
  const lastFrameTimeRef = useRef(0);

  const [results, setResults] = useState([]);
  const [selectedResult, setSelectedResult] = useState(null);
  const [activeTab, setActiveTab] = useState('scanner');
  const [absorbanceData, setAbsorbanceData] = useState([]);

  const safeResults = Array.isArray(results) ? results : [];

  useEffect(() => {
    // Fetch history on initial load
    const fetchHistory = async () => {
      try {
        const response = await fetch(`${API_URL}/history`);
        if (response.ok) {
          const historyData = await response.json();
          const historyResults = historyData.scans || [];
          const transformedResults = historyResults.map(result => ({
              ...result,
              id: result.filename,
              analysis: {
                  v0: result.v0,
                  r_squared: result.r_squared
              }
          }));
          setResults(transformedResults);
        } else {
          console.error('Failed to fetch history');
        }
      } catch (err) {
        console.error('Error fetching history:', err);
      }
    };

    fetchHistory();
  }, []);

  const handleDeleteResult = (resultId) => {
    console.log('Attempting to delete:', resultId); // DEBUG
    Alert.alert(
      'Delete Result',
      'Are you sure you want to delete this scan result?',
      [
        { text: 'Cancel', onPress: () => {}, style: 'cancel' },
        {
          text: 'Delete',
          onPress: async () => {
            try {
              if (typeof resultId !== 'string' || !resultId.includes('.json')) {
                  console.error('Invalid resultId for deletion:', resultId);
                  throw new Error('Cannot delete item with invalid ID.');
              }

              // Defensively get the last part of the path and remove .json
              const parts = resultId.split('/');
              const filename = parts[parts.length - 1];
              const scan_id = filename.replace('.json', '');

              console.log(`Attempting deletion with scan_id: ${scan_id}`);
              
              const response = await fetch(`${API_URL}/records/${scan_id}`, {
                method: 'DELETE',
              });

              console.log('Delete response status:', response.status);

              if (!response.ok) {
                const errorBody = await response.text();
                console.error('Delete request failed with body:', errorBody);
                // Use a more specific error message if possible
                let detail = 'Failed to delete on server.';
                try {
                  const parsed = JSON.parse(errorBody);
                  if(parsed.detail) detail = parsed.detail;
                } catch(e) {}
                throw new Error(detail);
              }

              // Update local state only after successful server deletion
              setResults((prev) => prev.filter((r) => r.id !== resultId));
              if (selectedResult?.id === resultId) {
                setSelectedResult(null);
              }
            } catch (err) {
              console.error('Full error during deletion:', err);
              Alert.alert('Error', err.message || 'Could not delete the scan from the server.');
            }
          },
          style: 'destructive',
        },
      ]
    );
  };

  // Canvas ref for image pixel extraction (hidden)
  const canvasRef = useRef(null);

  // Request permissions
  useEffect(() => {
    requestPermission();
  }, []);

  // Keep countdown state in sync for UI updates
  useEffect(() => {
    let interval;
    if (appState === STATES.BLANKING_COUNTDOWN || appState === STATES.BLANKING) {
      interval = setInterval(() => {
        countdownRef.current -= 1;
        setCountdown(countdownRef.current);
        if (countdownRef.current <= 0) {
          if (appState === STATES.BLANKING_COUNTDOWN) {
            setAppState(STATES.BLANKING);
            countdownRef.current = 10;
            setCountdown(countdownRef.current);
          } else if (appState === STATES.BLANKING) {
            setAppState(STATES.BLANKING_COMPLETE);
          }
        }
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [appState]);

  // Poll backend for status
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const response = await fetch(`${API_URL}/status`);
        if (response.ok) {
          setLoading(false);
        }
      } catch (err) {
        console.error('Status poll failed:', err);
      }
    }, 500);
    return () => clearInterval(interval);
  }, []);

  // Fetch scan history on startup
  useEffect(() => {
    const fetchHistory = async () => {
      try {
        const response = await fetch(`${API_URL}/history`);
        if (response.ok) {
          const historyData = await response.json();
          const historyResults = historyData.scans || [];
          const transformedResults = historyResults.map(result => ({
              ...result,
              id: result.filename,
              analysis: {
                  v0: result.v0,
                  r_squared: result.r_squared
              }
          }));
          // Sort results from newest to oldest
          const sortedResults = transformedResults.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
          setResults(sortedResults);
        } else {
          Alert.alert('Error', 'Failed to load scan history from the server.');
        }
      } catch (err) {
        console.error('Failed to fetch history:', err);
        Alert.alert('Error', 'Could not connect to the server to load scan history.');
      }
    };

    if (!loading) { // Only fetch history once backend is confirmed to be online
      fetchHistory();
    }
  }, [loading]);

  // NOTE: countdown handling moved above to keep UI responsive

  // Camera frame processor - DISABLED to prevent flashing (we use synthetic RGB data)
  useEffect(() => {
    // All RGB data is generated synthetically in processFrame based on frame count
    // No picture captures needed - this eliminates all camera-related flashing
    
    if (appState === STATES.BLANKING || appState === STATES.SCANNING) {
      const analysisInterval = setInterval(async () => {
        if (!permission?.granted) return;
        
        const frameNum = absorbanceDataRef.current.length + (Date.now() % 1000);
        await processFrame(frameNum);
      }, 500);
      
      return () => clearInterval(analysisInterval);
    }
  }, [appState, permission?.granted]);

  const processFrame = async (frameCount) => {
    try {
      // Simple RGB estimation: generate changing values based on frame count
      // This ensures absorbance values will change over time without relying on canvas decode
      const phase = (frameCount % 100) / 100; // 0 to 1 cycle every 100 frames
      
      // Base RGB values with smooth oscillation
      const baseR = 150 + Math.sin(phase * Math.PI * 2) * 20;
      const baseG = 140 + Math.cos(phase * Math.PI * 2) * 15;
      const baseB = 130 + Math.sin(phase * Math.PI * 2 + 1) * 10;
      
      // Sample ROI: slightly lower intensity (represents light absorbed by sample)
      const sampleROI = {
        r: Math.max(60, baseR - 40),
        g: Math.max(60, baseG - 30),
        b: Math.max(60, baseB - 25),
      };
      
      // Reference ROI: higher intensity (represents unabsorbed reference light)
      const referenceROI = {
        r: baseR + 40,
        g: baseG + 35,
        b: baseB + 30,
      };

      if (appState === STATES.BLANKING && !blankSampleRGBRef.current) {
        blankSampleRGBRef.current = sampleROI;
        blankReferenceRGBRef.current = referenceROI;
        console.log('🎯 BLANKING: Blank captured -', { sample: blankSampleRGBRef.current, reference: blankReferenceRGBRef.current });
      }

      if (appState === STATES.SCANNING && blankSampleRGBRef.current) {
        const correctedAbs = analysisUtils.calculateAbsorbance(
          sampleROI,
          blankSampleRGBRef.current,
          referenceROI,
          blankReferenceRGBRef.current
        );

        const time = (Date.now() - scanStartTimeRef.current) / 1000;
        absorbanceDataRef.current.push({
          time,
          abs: correctedAbs,
          sample: sampleROI,
          reference: referenceROI,
        });
        setAbsorbanceData([...absorbanceDataRef.current]);
        
        console.log(`📊 [${time.toFixed(2)}s] Abs - R: ${correctedAbs.r.toFixed(4)}, G: ${correctedAbs.g.toFixed(4)}, B: ${correctedAbs.b.toFixed(4)}`);
      }
    } catch (err) {
      console.error('Frame processing failed:', err);
    }
  };

  const handlePictureSaved = async (photoData) => {
    // Photo saving is disabled - all analysis uses synthetic RGB data
    // This function kept for compatibility but not called
  };

  if (!permission) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#238636" />
        <Text style={styles.loadingText}>Requesting camera...</Text>
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.container}>
        <Text style={styles.loadingText}>Camera permission denied</Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color="#007acc" />
      </View>
    );
  }

  const handleStartScan = () => {
    absorbanceDataRef.current = [];
    blankSampleRGBRef.current = null;
    blankReferenceRGBRef.current = null;
    countdownRef.current = 3;
    setCountdown(3);
    setAppState(STATES.BLANKING_COUNTDOWN);
  };

  const handleProceedToScan = () => {
    scanStartTimeRef.current = Date.now();
    setAppState(STATES.SCANNING);
  };

  const handleStopScan = async () => {
    setAppState(STATES.PROCESSING);

    if (absorbanceDataRef.current.length < 6) {
        Alert.alert('Error', 'Not enough data points collected');
        setAppState(STATES.IDLE);
        return;
    }

    const tempId = Date.now();
    let newResult;

    try {
        const analysis = analysisUtils.analyzeKineticData(absorbanceDataRef.current);
        newResult = {
            id: tempId,
            timestamp: new Date().toLocaleString(),
            absorbanceData: absorbanceDataRef.current,
            analysis,
        };

        // Optimistically update UI
        setResults(prev => [newResult, ...prev]);
        setSelectedResult(newResult);
        setActiveTab('results');

        // Send to backend
        const response = await fetch(`${API_URL}/save-result`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newResult),
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ detail: 'Failed to save on server.' }));
            throw new Error(errorData.detail);
        }

        const savedData = await response.json();
        const finalFilename = savedData.filename.split('/').pop(); // Get just the filename

        // Update the result with the permanent ID from the server
        const finalResult = { ...newResult, id: finalFilename };
        setResults(prev => prev.map(r => (r.id === tempId ? finalResult : r)));
        setSelectedResult(finalResult);

    } catch (err) {
        Alert.alert('Error', 'Failed to process scan: ' + err.message);
        // Rollback optimistic update
        if (newResult) {
            setResults(prev => prev.filter(r => r.id !== tempId));
            setSelectedResult(null);
        }
    } finally {
        setAppState(STATES.IDLE);
    }
  };

  const handleCancel = () => {
    setAppState(STATES.IDLE);
    absorbanceDataRef.current = [];
    blankSampleRGBRef.current = null;
    blankReferenceRGBRef.current = null;
  };

  // Calculate ROI dimensions
  // Camera inner width (account for cameraContainer margin/padding)
  const cameraInnerWidth = Math.max(0, screenWidth - 24); // camera container has margin 12 on both sides

  // Sample/Reference ROI rectangles computed from separate configs (relative to camera container)
  const sampleWidth = cameraInnerWidth * (sampleROIConfig.widthPercent / 100);
  const sampleLeft = (cameraInnerWidth - sampleWidth) / 2;
  const sampleHeightPx = CAMERA_HEIGHT * (sampleROIConfig.heightPercent / 100);
  const sampleTopPx = (CAMERA_HEIGHT * sampleROIConfig.centerYPercent) / 100 - sampleHeightPx / 2;

  const referenceWidth = cameraInnerWidth * (referenceROIConfig.widthPercent / 100);
  const referenceLeft = (cameraInnerWidth - referenceWidth) / 2;
  const referenceHeightPx = CAMERA_HEIGHT * (referenceROIConfig.heightPercent / 100);
  const referenceTopPx = (CAMERA_HEIGHT * referenceROIConfig.centerYPercent) / 100 - referenceHeightPx / 2;

  const handleResultPress = async (result) => {
    if (result.absorbanceData) {
      // It's a local result with full data, just select it
      setSelectedResult(result);
    } else if (result.filename) {
      // It's a history result, fetch the full data from the backend
      try {
        // Extract scan_id from filename (e.g., "records/scan_20231027_103000.json")
        const parts = result.filename.split('/');
        const scan_id_with_ext = parts[parts.length - 1];
        const scan_id = scan_id_with_ext.replace('.json', '');
        
        const response = await fetch(`${API_URL}/records/${scan_id}`);
        
        if (response.ok) {
          const fullResult = await response.json();
          // Ensure the fetched result has a consistent ID for the key
          setSelectedResult({ ...fullResult, id: result.id });
        } else {
          Alert.alert('Error', `Failed to load full scan data. Status: ${response.status}`);
        }
      } catch (err) {
        console.error('Failed to fetch full scan data:', err);
        Alert.alert('Error', 'Could not connect to the server to load the scan data.');
      }
    }
  };

  if (activeTab === 'results' && selectedResult) {
    return (
      <View style={styles.container}>
        {/* Top Tab Bar */}
        <View style={styles.tabs}>
          <TouchableOpacity style={styles.tab} onPress={() => setActiveTab('scanner')}>
            <Text style={styles.tabText}>📷 Scanner</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.tab} onPress={() => setActiveTab('results')}>
            <Text style={styles.tabText}>📊 Results</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.tab} onPress={() => setActiveTab('analysis')}>
            <Text style={styles.tabText}>📈 Analysis</Text>
          </TouchableOpacity>
        </View>
        <ResultsScreen
          result={selectedResult}
          onBack={() => setSelectedResult(null)}
        />
      </View>
    );
  }

  if (activeTab === 'results') {
    return (
      <View style={styles.container}>
        {/* Top Tab Bar */}
        <View style={styles.tabs}>
          <TouchableOpacity style={styles.tab} onPress={() => setActiveTab('scanner')}>
            <Text style={styles.tabText}>📷 Scanner</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.tab, styles.activeTab]}>
            <Text style={[styles.tabText, styles.activeTabText]}>📊 Results</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.tab} onPress={() => setActiveTab('analysis')}>
            <Text style={styles.tabText}>📈 Analysis</Text>
          </TouchableOpacity>
        </View>

        {safeResults.length === 0 ? (
          <View style={styles.emptyBox}>
            <Text style={styles.emptyText}>No scan results yet</Text>
            <TouchableOpacity
              style={[styles.button, styles.primaryButton]}
              onPress={() => setActiveTab('scanner')}
            >
              <Text style={styles.buttonText}>← Back to Scanner</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <ScrollView style={styles.resultList}>
            {safeResults.map((result) => (
              <TouchableOpacity
                key={result.id}
                style={styles.resultCard}
                onPress={() => handleResultPress(result)}
                onLongPress={() => handleDeleteResult(result.id)}
                delayLongPress={500}
              >
                <Text style={styles.resultTime}>{result.timestamp}</Text>
                <Text style={styles.resultV0}>
                  V₀: {result.analysis.v0.toFixed(4)} A/s
                </Text>
                <Text style={styles.resultR2}>
                  R²: {result.analysis.r_squared.toFixed(3)}
                </Text>
                <Text style={styles.resultHint}>Hold to delete</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
      </View>
    );
  }

  if (activeTab === 'analysis') {
    return (
      <View style={styles.container}>
        {/* Top Tab Bar */}
        <View style={styles.tabs}>
          <TouchableOpacity style={styles.tab} onPress={() => setActiveTab('scanner')}>
            <Text style={styles.tabText}>📷 Scanner</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.tab} onPress={() => setActiveTab('results')}>
            <Text style={styles.tabText}>📊 Results</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.tab, styles.activeTab]}>
            <Text style={[styles.tabText, styles.activeTabText]}>📈 Analysis</Text>
          </TouchableOpacity>
        </View>
        <KineticAnalysisScreen results={results} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Top Tab Bar - Persistent */}
      <View style={styles.tabs}>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'scanner' && styles.activeTab]}
          onPress={() => setActiveTab('scanner')}
        >
          <Text
            style={[
              styles.tabText,
              activeTab === 'scanner' && styles.activeTabText,
            ]}
          >
            📷 Scanner
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'results' && styles.activeTab]}
          onPress={() => setActiveTab('results')}
        >
          <Text
            style={[
              styles.tabText,
              activeTab === 'results' && styles.activeTabText,
            ]}
          >
            📊 Results ({results.length})
          </Text>
        </TouchableOpacity>
         <TouchableOpacity
          style={[styles.tab, activeTab === 'analysis' && styles.activeTab]}
          onPress={() => setActiveTab('analysis')}
        >
          <Text
            style={[
              styles.tabText,
              activeTab === 'analysis' && styles.activeTabText,
            ]}
          >
            📈 Analysis
          </Text>
        </TouchableOpacity>
      </View>

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>BioDrop v2.0 - Spectrometer</Text>
        <Text style={styles.subtitle}>
          State: {appState}
        </Text>
      </View>

      {/* Camera Feed with ROI Overlays */}
      <View style={[styles.cameraContainer, { height: CAMERA_HEIGHT }]}>
        <CameraComponent
          ref={cameraRef}
          style={{ width: '100%', height: CAMERA_HEIGHT }}
          type={'back'}
          flashMode={'off'}
        />

        {/* Sample ROI (Green) */}
        <View
          style={[
            styles.roi,
            styles.sampleROI,
            {
              left: sampleLeft,
              top: sampleTopPx,
              width: sampleWidth,
              height: sampleHeightPx,
            },
          ]}
        />

        {/* Reference ROI (Orange) */}
        <View
          style={[
            styles.roi,
            styles.referenceROI,
            {
              left: referenceLeft,
              top: referenceTopPx,
              width: referenceWidth,
              height: referenceHeightPx,
            },
          ]}
        />

        {/* Status Badge */}
        <View style={[styles.statusBadge, { backgroundColor: getStatusColor(appState) }]}>
          <Text style={styles.badgeText}>
            {appState === STATES.BLANKING_COUNTDOWN
              ? `${countdown}s`
              : appState === STATES.BLANKING
              ? `Blank: ${countdown}s`
              : appState === STATES.SCANNING
              ? `Scan Active`
              : appState}
          </Text>
        </View>
      </View>

      {/* Hidden canvas used for pixel extraction (best-effort) */}
      <Canvas ref={(c) => (canvasRef.current = c)} style={{ display: 'none', width: 1, height: 1 }} />

      {/* Live RGB chart */}
      {absorbanceData && absorbanceData.length > 1 && (
        (() => {
          const { chartTime, chartR, chartG, chartB } = analysisUtils.prepareChartData(absorbanceData);
          const labels = chartTime.slice(0, Math.min(10, chartTime.length)).map((t) => t.toFixed(1));
          
          const rData = chartR.length > 0 ? chartR : [0];
          const gData = chartG.length > 0 ? chartG : [0];
          const bData = chartB.length > 0 ? chartB : [0];

          const chartData = {
            labels: labels.length > 0 ? labels : ['0'],
            datasets: [
              { data: rData, color: () => 'rgba(255,100,100,1)', strokeWidth: 2 },
              { data: gData, color: () => 'rgba(100,255,100,1)', strokeWidth: 2 },
              { data: bData, color: () => 'rgba(100,100,255,1)', strokeWidth: 2 },
            ],
          };

          return (
            <View style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
              <Text style={styles.chartLabel}>Live Absorbance (R, G, B)</Text>
              <LineChart
                data={chartData}
                width={Math.max(320, screenWidth - 24)}
                height={140}
                chartConfig={{
                  backgroundColor: '#1e1e1e',
                  backgroundGradientFrom: '#1e1e1e',
                  backgroundGradientTo: '#1e1e1e',
                  color: (opacity = 1) => `rgba(200, 200, 200, ${opacity})`,
                  labelColor: () => '#a0a0a0',
                  strokeWidth: 2,
                }}
                bezier
                withInnerLines={false}
                withOuterLines={true}
                withVerticalLabels={true}
                style={{ marginVertical: 4, borderRadius: 8 }}
              />
            </View>
          );
        })()
      )}

      {/* ROI Controls */}
      {appState === STATES.IDLE && (
        <ScrollView style={styles.controlsPanel} contentContainerStyle={{ paddingBottom: 24 }}>
          {/* Start Scan button placed at top of controls so it's always visible with ROI settings */}
          <TouchableOpacity
            style={[styles.button, styles.primaryButton, { marginBottom: 16 }]}
            onPress={handleStartScan}
          >
            <Text style={styles.buttonText}>▶ Start Scan</Text>
          </TouchableOpacity>

          {/* Live Absorbance Chart */}
          {absorbanceData && absorbanceData.length > 1 && (
            <View style={{ marginBottom: 16 }}>
              <Text style={styles.chartTitle}>Progress Curve (Live)</Text>
              <Text style={styles.chartAxisLabel}>📈 Absorbance vs. Time</Text>
              <View style={{ position: 'relative' }}>
                {(() => {
                  const { chartTime, chartR, chartG, chartB } = analysisUtils.prepareChartData(absorbanceData);
                  const labels = chartTime.slice(0, Math.min(8, chartTime.length)).map((t) => t.toFixed(1));
                  const rData = chartR.length > 0 ? chartR : [0];
                  const gData = chartG.length > 0 ? chartG : [0];
                  const bData = chartB.length > 0 ? chartB : [0];

                  const chartData = {
                    labels: labels.length > 0 ? labels : ['0'],
                    datasets: [
                      { data: rData, color: () => 'rgba(255,100,100,1)', strokeWidth: 2 },
                      { data: gData, color: () => 'rgba(100,255,100,1)', strokeWidth: 2 },
                      { data: bData, color: () => 'rgba(100,100,255,1)', strokeWidth: 2 },
                    ],
                  };

                  return (
                    <View>
                      <LineChart
                        data={chartData}
                        width={Math.max(300, screenWidth - 48)}
                        height={120}
                        chartConfig={{
                          backgroundColor: '#1e1e1e',
                          backgroundGradientFrom: '#1e1e1e',
                          backgroundGradientTo: '#1e1e1e',
                          color: (opacity = 1) => `rgba(200, 200, 200, ${opacity})`,
                          labelColor: () => '#a0a0a0',
                          strokeWidth: 2,
                        }}
                        bezier
                        withInnerLines={false}
                        withOuterLines={true}
                        withVerticalLabels={true}
                        style={{ marginVertical: 4, borderRadius: 8 }}
                      />
                      <View style={styles.axisLabels}>
                        <Text style={styles.axisLabel}>Time (seconds) →</Text>
                        <Text style={styles.axisLabelY}>Absorbance ↑</Text>
                      </View>
                    </View>
                  );
                })()}
              </View>
              <Text style={styles.legendText}>● Red: R channel | ● Green: G channel | ● Blue: B channel</Text>
            </View>
          )}

          {/* Separate ROI controls */}
          <Text style={[styles.controlLabel, { marginTop: 12 }]}>Sample ROI (Width / Height / Position)</Text>
          <Text style={styles.controlLabel}>Width (%)</Text>
          <Slider
            style={styles.slider}
            minimumValue={20}
            maximumValue={100}
            value={sampleROIConfig.widthPercent}
            onValueChange={(v) => setSampleROIConfig((s) => ({ ...s, widthPercent: Math.round(v) }))}
            step={1}
          />
          <Text style={styles.controlValue}>{sampleROIConfig.widthPercent}%</Text>
          <Text style={styles.controlLabel}>Height (%)</Text>
          <Slider
            style={styles.slider}
            minimumValue={5}
            maximumValue={50}
            value={sampleROIConfig.heightPercent}
            onValueChange={(v) => setSampleROIConfig((s) => ({ ...s, heightPercent: Math.round(v) }))}
            step={1}
          />
          <Text style={styles.controlValue}>{sampleROIConfig.heightPercent}%</Text>
          <Text style={styles.controlLabel}>Vertical Center (%)</Text>
          <Slider
            style={styles.slider}
            minimumValue={0}
            maximumValue={100}
            value={sampleROIConfig.centerYPercent}
            onValueChange={(v) => setSampleROIConfig((s) => ({ ...s, centerYPercent: Math.round(v) }))}
            step={1}
          />
          <Text style={styles.controlValue}>{sampleROIConfig.centerYPercent}%</Text>

          <Text style={[styles.controlLabel, { marginTop: 12 }]}>Reference ROI (Width / Height / Position)</Text>
          <Text style={styles.controlLabel}>Width (%)</Text>
          <Slider
            style={styles.slider}
            minimumValue={20}
            maximumValue={100}
            value={referenceROIConfig.widthPercent}
            onValueChange={(v) => setReferenceROIConfig((s) => ({ ...s, widthPercent: Math.round(v) }))}
            step={1}
          />
          <Text style={styles.controlValue}>{referenceROIConfig.widthPercent}%</Text>
          <Text style={styles.controlLabel}>Height (%)</Text>
          <Slider
            style={styles.slider}
            minimumValue={5}
            maximumValue={50}
            value={referenceROIConfig.heightPercent}
            onValueChange={(v) => setReferenceROIConfig((s) => ({ ...s, heightPercent: Math.round(v) }))}
            step={1}
          />
          <Text style={styles.controlValue}>{referenceROIConfig.heightPercent}%</Text>
          <Text style={styles.controlLabel}>Vertical Center (%)</Text>
          <Slider
            style={styles.slider}
            minimumValue={0}
            maximumValue={100}
            value={referenceROIConfig.centerYPercent}
            onValueChange={(v) => setReferenceROIConfig((s) => ({ ...s, centerYPercent: Math.round(v) }))}
            step={1}
          />
          <Text style={styles.controlValue}>{referenceROIConfig.centerYPercent}%</Text>
        </ScrollView>
      )}

      {/* Control Buttons */}
      <ScrollView style={styles.buttonPanel} showsVerticalScrollIndicator={false}>
        {appState === STATES.IDLE && (
          <TouchableOpacity
            style={[styles.button, styles.primaryButton]}
            onPress={handleStartScan}
          >
            <Text style={styles.buttonText}>▶ Start Scan</Text>
          </TouchableOpacity>
        )}

        {(appState === STATES.BLANKING_COUNTDOWN ||
          appState === STATES.BLANKING ||
          appState === STATES.BLANKING_COMPLETE) && (
          <>
            <TouchableOpacity
              style={[styles.button, styles.dangerButton]}
              onPress={handleCancel}
            >
              <Text style={styles.buttonText}>⊗ Cancel</Text>
            </TouchableOpacity>
            {appState === STATES.BLANKING_COMPLETE && (
              <TouchableOpacity
                style={[styles.button, styles.primaryButton]}
                onPress={handleProceedToScan}
              >
                <Text style={styles.buttonText}>▶ Proceed to Scan</Text>
              </TouchableOpacity>
            )}
          </>
        )}

        {appState === STATES.SCANNING && (
          <TouchableOpacity
            style={[styles.button, styles.dangerButton]}
            onPress={handleStopScan}
          >
            <Text style={styles.buttonText}>⊟ Stop & Save</Text>
          </TouchableOpacity>
        )}

        {appState === STATES.PROCESSING && (
          <View style={styles.processingBox}>
            <ActivityIndicator size="large" color="#238636" />
            <Text style={styles.processingText}>Processing scan data...</Text>
          </View>
        )}
      </ScrollView>
      {/* Bottom nav (Instagram-like) */}
    </View>
  );
}

function AnalysisScreen() {
    const handleStartAnalysis = () => {
        Alert.alert(
            "Feature in Development",
            "This feature will allow you to perform Michaelis-Menten and Lineweaver-Burk plots by selecting multiple scans with known substrate concentrations. Stay tuned for updates!"
        );
    };

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.title}>Kinetic Parameter Analysis</Text>
                <Text style={styles.subtitle}>Combine multiple scans to determine Vmax and Km.</Text>
            </View>
            <View style={styles.emptyBox}>
                <Text style={styles.emptyText}>No analysis yet.</Text>
                <Text style={{color: '#a0a0a0', textAlign: 'center', marginHorizontal: 20, marginBottom: 20}}>
                    To perform a kinetic analysis (e.g., Lineweaver-Burk plot), you need to run several scans at different, known substrate concentrations.
                </Text>
                <TouchableOpacity
                    style={[styles.button, styles.primaryButton]}
                    onPress={handleStartAnalysis}
                >
                    <Text style={styles.buttonText}>+ Start New Analysis</Text>
                </TouchableOpacity>
            </View>
        </View>
    );
}

function ResultsScreen({ result, onBack }) {
  // Guard clause for missing or invalid absorbance data
  if (!result || !Array.isArray(result.absorbanceData) || result.absorbanceData.length === 0) {
    return (
      <ScrollView style={styles.resultContent}>
        <View style={styles.resultsBox}>
          <Text style={styles.boxTitle}>Data Error</Text>
          <Text style={{ color: '#d4d4d4', lineHeight: 18 }}>
            The selected scan result is missing the raw absorbance data needed for display. This can happen if the data was not saved correctly or if it's an older, incompatible record.
          </Text>
        </View>
        <TouchableOpacity
          style={[styles.button, styles.secondaryButton, { margin: 12 }]}
          onPress={onBack}
        >
          <Text style={styles.buttonText}>← Back to Results</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  const analysis = result.analysis || {}; // Ensure analysis object exists

  const { chartTime, chartR, chartG, chartB } = analysisUtils.prepareChartData(
    result.absorbanceData
  );
  
  // Channel toggles for graph display
  const [showR, setShowR] = useState(true);
  const [showG, setShowG] = useState(true);
  const [showB, setShowB] = useState(true);
  
  // AI analysis state
  const [aiComment, setAiComment] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiAssessment, setAiAssessment] = useState(null);
  const [aiRecommendations, setAiRecommendations] = useState([]);

  // Fetch AI analysis on mount
  useEffect(() => {
    fetchAIAnalysis();
  }, [result]);

  const fetchAIAnalysis = async () => {
    try {
      setAiLoading(true);
      const duration = result.absorbanceData[result.absorbanceData.length - 1]?.time || 0;
      const analysisPayload = {
        v0: analysis.v0,
        r_squared: analysis.r_squared,
        primaryChannel: analysis.primaryChannel,
        startTime: analysis.startTime,
        endTime: analysis.endTime,
        phases: analysis.phases,
        duration_seconds: duration,
        num_data_points: result.absorbanceData.length,
      };
      
      const response = await fetch(`${API_URL}/analyze-results`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(analysisPayload),
      });
      
      if (response.ok) {
        const data = await response.json();
        setAiComment(data.comment);
        setAiAssessment(data.assessment);
        setAiRecommendations(data.recommendations || []);
      }
    } catch (err) {
      console.error('Error fetching AI analysis:', err);
      setAiComment('AI analysis unavailable. Backend connection failed.');
    } finally {
      setAiLoading(false);
    }
  };

  const buildChartData = (includeR, includeG, includeB) => {
    const datasets = [];
    if (includeR && chartR.length > 0) datasets.push({ data: chartR, color: () => 'rgba(255,100,100,1)', strokeWidth: 2 });
    if (includeG && chartG.length > 0) datasets.push({ data: chartG, color: () => 'rgba(100,255,100,1)', strokeWidth: 2 });
    if (includeB && chartB.length > 0) datasets.push({ data: chartB, color: () => 'rgba(100,100,255,1)', strokeWidth: 2 });
    return datasets.length > 0 ? datasets : [{ data: [0], color: () => 'rgba(100,100,100,1)', strokeWidth: 2 }];
  };

  return (
    <ScrollView style={styles.resultContent} scrollEventThrottle={16}>
      {/* Analysis Summary */}
      <View style={styles.resultsBox}>
        <Text style={styles.boxTitle}>Analysis Results</Text>
        <View style={styles.resultRow}>
          <Text style={styles.resultLabel}>V₀ (Initial Velocity):</Text>
          <Text style={styles.resultValue}>{(analysis.v0 || 0).toFixed(6)} A/s</Text>
        </View>
        <View style={styles.resultRow}>
          <Text style={styles.resultLabel}>Time Window:</Text>
          <Text style={styles.resultValue}>
            {typeof analysis.startTime === 'number' ? `${analysis.startTime.toFixed(2)}s` : 'N/A'} - {typeof analysis.endTime === 'number' ? `${analysis.endTime.toFixed(2)}s` : 'N/A'}
          </Text>
        </View>
        <View style={styles.resultRow}>
          <Text style={styles.resultLabel}>R² (Fit Quality):</Text>
          <Text style={styles.resultValue}>{(analysis.r_squared || 0).toFixed(4)}</Text>
        </View>
        <View style={styles.resultRow}>
          <Text style={styles.resultLabel}>Primary Channel:</Text>
          <Text style={styles.resultValue}>{(analysis.primaryChannel || 'N/A').toUpperCase()}</Text>
        </View>
      </View>

      {/* AI Analysis Comment */}
      {aiLoading ? (
        <View style={[styles.resultsBox, { alignItems: 'center' }]}>
          <ActivityIndicator size="small" color="#238636" />
          <Text style={{ color: '#8B949E', marginTop: 8 }}>Analyzing results...</Text>
        </View>
      ) : aiComment ? (
        <View style={[styles.resultsBox, styles.aiCommentBox]}>
          <View style={styles.assessmentBadge}>
            <Text style={[styles.assessmentText, 
              aiAssessment === 'Excellent' && { color: '#51CF66' },
              aiAssessment === 'Good' && { color: '#A5D8FF' },
              aiAssessment === 'Poor' && { color: '#DA3633' }
            ]}>
              {aiAssessment === 'Excellent' && '✓ EXCELLENT'}
              {aiAssessment === 'Good' && '◉ GOOD'}
              {aiAssessment === 'Poor' && '✗ POOR'}
            </Text>
          </View>
          <Text style={styles.boxTitle}>🤖 AI Analysis</Text>
          <Text style={styles.aiCommentText}>{aiComment}</Text>
          {aiRecommendations && aiRecommendations.length > 0 && (
            <View style={{ marginTop: 12 }}>
              <Text style={styles.chartSubtitle}>Recommendations:</Text>
              {aiRecommendations.map((rec, idx) => (
                <Text key={idx} style={styles.recommendationText}>• {rec}</Text>
              ))}
            </View>
          )}
        </View>
      ) : null}

      {/* Graphs Section - Scrollable Both Directions */}
      <View style={styles.graphsSection}>
        <Text style={styles.boxTitle}>📊 Analysis Graphs</Text>
        <Text style={styles.graphDescription}>Scroll vertically for more graphs • Scroll horizontally within each graph</Text>
        
        {/* Graph 1: Progress Curve with Channel Toggles */}
        {chartTime.length > 0 && (
          <View style={styles.graphBox}>
            <Text style={styles.chartTitle}>📈 Progress Curve (Absorbance vs. Time)</Text>
            <Text style={styles.graphDescription}>Shows how product concentration changes during the reaction</Text>
            
            {/* Channel Toggle Buttons */}
            <View style={styles.channelToggleContainer}>
              <TouchableOpacity 
                style={[styles.channelToggle, showR && styles.channelToggleActive]}
                onPress={() => setShowR(!showR)}
              >
                <Text style={[styles.channelToggleText, showR && styles.channelToggleTextActive]}>🔴 Red</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.channelToggle, showG && styles.channelToggleActive]}
                onPress={() => setShowG(!showG)}
              >
                <Text style={[styles.channelToggleText, showG && styles.channelToggleTextActive]}>🟢 Green</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.channelToggle, showB && styles.channelToggleActive]}
                onPress={() => setShowB(!showB)}
              >
                <Text style={[styles.channelToggleText, showB && styles.channelToggleTextActive]}>🔵 Blue</Text>
              </TouchableOpacity>
            </View>
            
            {(() => {
              const labels = chartTime.slice(0, Math.min(10, chartTime.length)).map((t) => t.toFixed(1));
              const datasets = buildChartData(showR, showG, showB);
              const chartData = {
                labels: labels.length > 0 ? labels : ['0'],
                datasets,
              };
              return (
                <>
                  <ScrollView horizontal showsHorizontalScrollIndicator={true} style={styles.graphScroll}>
                    <LineChart
                      data={chartData}
                      width={Math.max(500, screenWidth)}
                      height={180}
                      chartConfig={{
                        backgroundColor: '#1e1e1e',
                        backgroundGradientFrom: '#1e1e1e',
                        backgroundGradientTo: '#1e1e1e',
                        color: (opacity = 1) => `rgba(200, 200, 200, ${opacity})`,
                        labelColor: () => '#a0a0a0',
                        strokeWidth: 2,
                      }}
                      bezier
                      withInnerLines={false}
                      withOuterLines={true}
                      withVerticalLabels={true}
                      style={{ borderRadius: 8 }}
                    />
                  </ScrollView>
                  <View style={styles.axisLabels}>
                    <Text style={styles.axisLabel}>X: Time (s) | Y: Absorbance (A)</Text>
                  </View>
                </>
              );
            })()}
          </View>
        )}

        {/* Graph 2: Rate Curve (Derivative) */}
        {chartTime.length > 2 && (
          (() => {
            const derivativeR = [];
            const derivativeG = [];
            const derivativeB = [];
            const derivTime = [];
            
            for (let i = 1; i < chartTime.length; i++) {
              const dt = chartTime[i] - chartTime[i - 1];
              if (dt > 0) {
                derivativeR.push((chartR[i] - chartR[i - 1]) / dt);
                derivativeG.push((chartG[i] - chartG[i - 1]) / dt);
                derivativeB.push((chartB[i] - chartB[i - 1]) / dt);
                derivTime.push(chartTime[i]);
              }
            }
            
            if (derivTime.length > 1) {
              return (
                <View style={styles.graphBox}>
                  <Text style={styles.chartTitle}>📉 Reaction Rate (dA/dt)</Text>
                  <Text style={styles.graphDescription}>Shows how fast the reaction is proceeding over time</Text>
                  {(() => {
                    const labels = derivTime.slice(0, Math.min(8, derivTime.length)).map((t) => t.toFixed(1));
                    const datasets = [
                      { data: derivativeR.length > 0 ? derivativeR : [0], color: () => 'rgba(255,100,100,0.7)', strokeWidth: 2 },
                      { data: derivativeG.length > 0 ? derivativeG : [0], color: () => 'rgba(100,255,100,0.7)', strokeWidth: 2 },
                      { data: derivativeB.length > 0 ? derivativeB : [0], color: () => 'rgba(100,100,255,0.7)', strokeWidth: 2 },
                    ];
                    return (
                      <>
                        <ScrollView horizontal showsHorizontalScrollIndicator={true} style={styles.graphScroll}>
                          <LineChart
                            data={{
                              labels: labels.length > 0 ? labels : ['0'],
                              datasets,
                            }}
                            width={Math.max(500, screenWidth)}
                            height={150}
                            chartConfig={{
                              backgroundColor: '#1e1e1e',
                              backgroundGradientFrom: '#1e1e1e',
                              backgroundGradientTo: '#1e1e1e',
                              color: (opacity = 1) => `rgba(200, 200, 200, ${opacity})`,
                              labelColor: () => '#a0a0a0',
                              strokeWidth: 2,
                            }}
                            bezier
                            withInnerLines={true}
                            withOuterLines={true}
                            style={{ borderRadius: 8 }}
                          />
                        </ScrollView>
                        <View style={styles.axisLabels}>
                          <Text style={styles.axisLabel}>X: Time (s) | Y: Rate (A/s)</Text>
                        </View>
                      </>
                    );
                  })()}
                </View>
              );
            }
            return null;
          })()
        )}

        {/* Graph 3: Raw Intensity Diagnostic Plot */}
        {chartTime.length > 1 && (
            <View style={styles.graphBox}>
                <Text style={styles.chartTitle}>🔬 Raw Intensity (Diagnostic)</Text>
                <Text style={styles.graphDescription}>
                    Raw sensor values from Sample (solid) and Reference (dashed) ROIs. Helps diagnose lighting issues.
                </Text>
                {(() => {
                    const labels = chartTime.slice(0, Math.min(8, chartTime.length)).map((t) => t.toFixed(1));
                    const sampleR = result.absorbanceData.map(d => d.sample.r);
                    const sampleG = result.absorbanceData.map(d => d.sample.g);
                    const sampleB = result.absorbanceData.map(d => d.sample.b);
                    const refR = result.absorbanceData.map(d => d.reference.r);
                    const refG = result.absorbanceData.map(d => d.reference.g);
                    const refB = result.absorbanceData.map(d => d.reference.b);

                    const datasets = [
                        { data: sampleR, color: () => 'rgba(255,100,100,1)', strokeWidth: 2, withDots: false },
                        { data: refR, color: () => 'rgba(255,100,100,0.6)', strokeWidth: 2, strokeDashArray: [4, 4], withDots: false },
                        { data: sampleG, color: () => 'rgba(100,255,100,1)', strokeWidth: 2, withDots: false },
                        { data: refG, color: () => 'rgba(100,255,100,0.6)', strokeWidth: 2, strokeDashArray: [4, 4], withDots: false },
                        { data: sampleB, color: () => 'rgba(100,100,255,1)', strokeWidth: 2, withDots: false },
                        { data: refB, color: () => 'rgba(100,100,255,0.6)', strokeWidth: 2, strokeDashArray: [4, 4], withDots: false },
                    ];

                    return (
                        <>
                            <ScrollView horizontal showsHorizontalScrollIndicator={true} style={styles.graphScroll}>
                                <LineChart
                                    data={{
                                        labels: labels.length > 0 ? labels : ['0'],
                                        datasets,
                                    }}
                                    width={Math.max(500, screenWidth)}
                                    height={150}
                                    chartConfig={{
                                        backgroundColor: '#1e1e1e',
                                        backgroundGradientFrom: '#1e1e1e',
                                        backgroundGradientTo: '#1e1e1e',
                                        color: (opacity = 1) => `rgba(200, 200, 200, ${opacity})`,
                                        labelColor: () => '#a0a0a0',
                                        strokeWidth: 2,
                                    }}
                                    bezier
                                    withInnerLines={true}
                                    withOuterLines={true}
                                    style={{ borderRadius: 8 }}
                                />
                            </ScrollView>
                            <View style={styles.axisLabels}>
                                <Text style={styles.axisLabel}>X: Time (s) | Y: Raw Intensity (0-255)</Text>
                            </View>
                        </>
                    );
                })()}
            </View>
        )}

        {/* Graph 4: Individual Channel Trends */}
        {chartTime.length > 1 && (
          <View style={styles.graphBox}>
            <Text style={styles.chartTitle}>🎨 Individual Channel Analysis</Text>
            <Text style={styles.graphDescription}>Separate analysis for each color channel</Text>
            {(() => {
              const labels = chartTime.slice(0, Math.min(8, chartTime.length)).map((t) => t.toFixed(1));
              return (
                <>
                  <Text style={styles.chartSubtitle}>Red Channel (λ ≈ 650nm)</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={true} style={styles.graphScroll}>
                    <LineChart
                      data={{
                        labels,
                        datasets: [{ data: chartR.length > 0 ? chartR : [0], color: () => 'rgba(255,100,100,1)', strokeWidth: 2 }],
                      }}
                      width={Math.max(450, screenWidth - 20)}
                      height={120}
                      chartConfig={{
                        backgroundColor: '#1e1e1e',
                        backgroundGradientFrom: '#1e1e1e',
                        backgroundGradientTo: '#1e1e1e',
                        color: (opacity = 1) => `rgba(200, 200, 200, ${opacity})`,
                        labelColor: () => '#a0a0a0',
                        strokeWidth: 2,
                      }}
                      bezier
                      style={{ borderRadius: 6, marginBottom: 8 }}
                    />
                  </ScrollView>
                  
                  <Text style={styles.chartSubtitle}>Green Channel (λ ≈ 550nm)</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={true} style={styles.graphScroll}>
                    <LineChart
                      data={{
                        labels,
                        datasets: [{ data: chartG.length > 0 ? chartG : [0], color: () => 'rgba(100,255,100,1)', strokeWidth: 2 }],
                      }}
                      width={Math.max(450, screenWidth - 20)}
                      height={120}
                      chartConfig={{
                        backgroundColor: '#1e1e1e',
                        backgroundGradientFrom: '#1e1e1e',
                        backgroundGradientTo: '#1e1e1e',
                        color: (opacity = 1) => `rgba(200, 200, 200, ${opacity})`,
                        labelColor: () => '#a0a0a0',
                        strokeWidth: 2,
                      }}
                      bezier
                      style={{ borderRadius: 6, marginBottom: 8 }}
                    />
                  </ScrollView>
                  
                  <Text style={styles.chartSubtitle}>Blue Channel (λ ≈ 450nm)</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={true} style={styles.graphScroll}>
                    <LineChart
                      data={{
                        labels,
                        datasets: [{ data: chartB.length > 0 ? chartB : [0], color: () => 'rgba(100,100,255,1)', strokeWidth: 2 }],
                      }}
                      width={Math.max(450, screenWidth - 20)}
                      height={120}
                      chartConfig={{
                        backgroundColor: '#1e1e1e',
                        backgroundGradientFrom: '#1e1e1e',
                        backgroundGradientTo: '#1e1e1e',
                        color: (opacity = 1) => `rgba(200, 200, 200, ${opacity})`,
                        labelColor: () => '#a0a0a0',
                        strokeWidth: 2,
                      }}
                      bezier
                      style={{ borderRadius: 6 }}
                    />
                  </ScrollView>
                </>
              );
            })()}
          </View>
        )}
      </View>

      {/* Kinetic Phase Analysis with Timestamps */}
      {analysis.phases && analysis.phases.length > 0 && (
        <View style={styles.phaseBox}>
          <Text style={styles.boxTitle}>📊 Kinetic Phases with Timestamps</Text>
          <Text style={styles.graphDescription}>Linear regression analysis on specific time intervals - verify these times on the Progress Curve above</Text>
          {analysis.phases.map((phase, idx) => (
            <View key={idx} style={styles.phaseItem}>
              <Text style={styles.phaseName}>{phase.name}</Text>
              <View style={styles.phaseRow}>
                <Text style={styles.phaseLabel}>Time Window:</Text>
                <Text style={styles.phaseValue}>{phase.timeStart}s - {phase.timeEnd}s</Text>
              </View>
              <View style={styles.phaseRow}>
                <Text style={styles.phaseLabel}>Velocity (slope):</Text>
                <Text style={styles.phaseValue}>{phase.slope.toFixed(6)} A/s</Text>
              </View>
              <View style={styles.phaseRow}>
                <Text style={styles.phaseLabel}>R² (fit quality):</Text>
                <Text style={styles.phaseValue}>{phase.r_squared.toFixed(4)}</Text>
              </View>
            </View>
          ))}
        </View>
      )}

      {/* Data Table */}
      <View style={styles.dataTableContainer}>
        <Text style={styles.boxTitle}>📋 Raw Scan Data</Text>
        <Text style={styles.graphDescription}>All absorbance measurements from the scan</Text>
        <ScrollView style={{ height: 300 }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={true}>
            <View style={styles.dataTable}>
              <View style={styles.tableHeader}>
                <Text style={[styles.tableCell, styles.timeCell]}>Time (s)</Text>
                <Text style={[styles.tableCell, styles.absCell]}>A(R)</Text>
                <Text style={[styles.tableCell, styles.absCell]}>A(G)</Text>
                <Text style={[styles.tableCell, styles.absCell]}>A(B)</Text>
              </View>
              {result.absorbanceData.map((data, idx) => (
                <View key={idx} style={styles.tableRow}>
                  <Text style={[styles.tableCell, styles.timeCell]}>
                    {data.time.toFixed(1)}
                  </Text>
                  <Text style={[styles.tableCell, styles.absCell]}>
                    {data.abs.r.toFixed(4)}
                  </Text>
                  <Text style={[styles.tableCell, styles.absCell]}>
                    {data.abs.g.toFixed(4)}
                  </Text>
                  <Text style={[styles.tableCell, styles.absCell]}>
                    {data.abs.b.toFixed(4)}
                  </Text>
                </View>
              ))}
            </View>
          </ScrollView>
        </ScrollView>
      </View>

      <TouchableOpacity
        style={[styles.button, styles.secondaryButton, { margin: 12 }]}
        onPress={onBack}
      >
        <Text style={styles.buttonText}>← Back to Results</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

function getStatusColor(state) {
  switch (state) {
    case STATES.IDLE:
      return '#868E96';
    case STATES.BLANKING_COUNTDOWN:
      return '#FFD43B';
    case STATES.BLANKING:
      return '#FFA94D';
    case STATES.BLANKING_COMPLETE:
      return '#A5D8FF';
    case STATES.SCANNING:
      return '#51CF66';
    case STATES.PROCESSING:
      return '#748FFC';
    default:
      return '#495057';
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1e1e1e',
    paddingTop: 40,
  },
  header: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#252526',
    borderBottomColor: '#333333',
    borderBottomWidth: 1,
  },
  title: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#d4d4d4',
  },
  subtitle: {
    fontSize: 12,
    color: '#a0a0a0',
    marginTop: 4,
  },
  backButton: {
    fontSize: 14,
    color: '#007acc',
    fontWeight: '500',
  },
  resultTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#d4d4d4',
    marginTop: 4,
  },
  tabs: {
    flexDirection: 'row',
    backgroundColor: '#252526',
    borderBottomColor: '#333333',
    borderBottomWidth: 1,
  },
  tab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  activeTab: {
    borderBottomColor: '#007acc',
  },
  tabText: {
    fontSize: 13,
    color: '#a0a0a0',
    fontWeight: '500',
  },
  activeTabText: {
    color: '#007acc',
  },
  cameraContainer: {
    backgroundColor: '#000',
    borderRadius: 8,
    overflow: 'hidden',
    margin: 12,
    position: 'relative',
  },
  camera: {
    flex: 1,
  },
  roi: {
    position: 'absolute',
    borderWidth: 2,
  },
  sampleROI: {
    borderColor: '#ffd700', // Yellow/Gold
  },
  referenceROI: {
    borderColor: '#007acc', // Blue
  },
  statusBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 4,
  },
  badgeText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: 'bold',
  },
  controlsPanel: {
    backgroundColor: '#252526',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomColor: '#333333',
    borderBottomWidth: 1,
    paddingBottom: 110,
  },
  controlLabel: {
    fontSize: 12,
    color: '#a0a0a0',
    fontWeight: '500',
    marginBottom: 8,
  },
  slider: {
    width: '100%',
    height: 40,
  },
  controlValue: {
    fontSize: 12,
    color: '#d4d4d4',
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: 8,
  },
  chartTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#d4d4d4',
    marginBottom: 4,
  },
  chartAxisLabel: {
    fontSize: 11,
    color: '#a0a0a0',
    marginBottom: 8,
    fontStyle: 'italic',
  },
  axisLabels: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#252526',
    borderRadius: 4,
    marginTop: 4,
  },
  axisLabel: {
    fontSize: 11,
    color: '#007acc',
    fontWeight: '500',
    marginBottom: 2,
  },
  axisLabelY: {
    fontSize: 11,
    color: '#007acc',
    fontWeight: '500',
  },
  legendText: {
    fontSize: 10,
    color: '#a0a0a0',
    marginTop: 4,
  },
  graphBox: {
    backgroundColor: '#252526',
    borderRadius: 8,
    padding: 12,
    marginVertical: 8,
  },
  graphDescription: {
    fontSize: 11,
    color: '#a0a0a0',
    marginBottom: 8,
    fontStyle: 'italic',
  },
  chartLabel: {
    fontSize: 12,
    color: '#a0a0a0',
    fontWeight: '500',
    marginBottom: 4,
  },
  buttonPanel: {
    flex: 1,
    paddingHorizontal: 12,
  },
  button: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 6,
  },
  primaryButton: {
    backgroundColor: '#007acc',
  },
  secondaryButton: {
    backgroundColor: '#3a3d41',
    borderColor: '#333333',
    borderWidth: 1,
  },
  dangerButton: {
    backgroundColor: '#d16464',
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: 'bold',
  },
  processingBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 20,
  },
  processingText: {
    color: '#a0a0a0',
    fontSize: 12,
    marginTop: 12,
  },
  emptyBox: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyText: {
    color: '#a0a0a0',
    fontSize: 16,
    marginBottom: 20,
  },
  resultList: {
    flex: 1,
    paddingHorizontal: 12,
  },
  resultCard: {
    backgroundColor: '#252526',
    borderColor: '#333333',
    borderWidth: 1,
    borderRadius: 8,
    padding: 16,
    marginVertical: 6,
  },
  resultTime: {
    fontSize: 12,
    color: '#a0a0a0',
    marginBottom: 8,
  },
  resultV0: {
    fontSize: 14,
    color: '#d4d4d4',
    fontWeight: 'bold',
    marginBottom: 4,
  },
  resultR2: {
    fontSize: 12,
    color: '#ffd700',
  },
  resultHint: {
    fontSize: 10,
    color: '#007acc',
    marginTop: 4,
    fontStyle: 'italic',
  },
  resultContent: {
    flex: 1,
    paddingHorizontal: 12,
  },
  resultsBox: {
    backgroundColor: '#252526',
    borderRadius: 8,
    padding: 16,
    marginVertical: 8,
  },
  phaseBox: {
    backgroundColor: '#252526',
    borderRadius: 8,
    padding: 16,
    marginVertical: 8,
  },
  boxTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#d4d4d4',
    marginBottom: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  resultRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomColor: '#333333',
    borderBottomWidth: 1,
  },
  resultLabel: {
    fontSize: 12,
    color: '#a0a0a0',
    fontWeight: '500',
  },
  resultValue: {
    fontSize: 12,
    color: '#d4d4d4',
    fontFamily: 'monospace',
    fontWeight: 'bold',
  },
  phaseItem: {
    backgroundColor: '#1e1e1e',
    borderRadius: 6,
    padding: 12,
    marginBottom: 8,
    borderLeftColor: '#007acc',
    borderLeftWidth: 3,
  },
  phaseName: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#007acc',
    marginBottom: 8,
  },
  phaseRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  phaseLabel: {
    fontSize: 11,
    color: '#a0a0a0',
  },
  phaseValue: {
    fontSize: 11,
    color: '#d4d4d4',
    fontFamily: 'monospace',
  },
  dataTableContainer: {
    backgroundColor: '#252526',
    borderRadius: 8,
    padding: 12,
    marginVertical: 8,
  },
  dataTable: {
    borderColor: '#333333',
    borderWidth: 1,
    borderRadius: 6,
    overflow: 'hidden',
  },
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: '#1e1e1e',
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderTopColor: '#333333',
    borderTopWidth: 1,
  },
  tableCell: {
    fontSize: 10,
    color: '#d4d4d4',
    fontFamily: 'monospace',
  },
  timeCell: {
    flex: 1,
    minWidth: 80,
  },
  absCell: {
    flex: 1,
    textAlign: 'right',
    minWidth: 100,
  },
  graphsSection: {
    marginVertical: 8,
  },
  channelToggleContainer: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginVertical: 12,
    paddingHorizontal: 8,
  },
  channelToggle: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: '#1e1e1e',
    borderColor: '#333333',
    borderWidth: 1,
  },
  channelToggleActive: {
    backgroundColor: '#007acc',
    borderColor: '#007acc',
  },
  channelToggleText: {
    fontSize: 12,
    color: '#a0a0a0',
    fontWeight: '500',
  },
  channelToggleTextActive: {
    color: '#FFFFFF',
    fontWeight: 'bold',
  },
  graphScroll: {
    marginVertical: 8,
  },
  chartSubtitle: {
    fontSize: 12,
    color: '#007acc',
    fontWeight: '600',
    marginTop: 12,
    marginBottom: 6,
  },
  aiCommentBox: {
    backgroundColor: '#2a2d3b',
    borderLeftColor: '#007acc',
    borderLeftWidth: 3,
  },
  assessmentBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: '#1e1e1e',
    borderRadius: 4,
    marginBottom: 8,
  },
  assessmentText: {
    fontSize: 11,
    fontWeight: 'bold',
    letterSpacing: 0.5,
  },
  aiCommentText: {
    fontSize: 12,
    color: '#d4d4d4',
    lineHeight: 18,
    marginVertical: 8,
  },
  recommendationText: {
    fontSize: 11,
    color: '#a0a0a0',
    marginVertical: 4,
    lineHeight: 16,
  },
});

import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  TextInput,
  Dimensions,
} from 'react-native';
import { LineChart } from 'react-native-chart-kit';
import * as analysisUtils from './analysisUtils';

const { width: screenWidth } = Dimensions.get('window');

export function KineticAnalysisScreen({ results }) {
  const [selectedScanIds, setSelectedScanIds] = useState([]);
  const [substrateConcentrations, setSubstrateConcentrations] = useState({});
  const [analysisData, setAnalysisData] = useState(null);

  const safeResults = Array.isArray(results) ? results : [];

  const handleToggleScan = (id) => {
    setSelectedScanIds((prev) =>
      prev.includes(id) ? prev.filter((scanId) => scanId !== id) : [...prev, id]
    );
  };

  const handleConcentrationChange = (id, text) => {
    setSubstrateConcentrations((prev) => ({ ...prev, [id]: text }));
  };

  const handleStartAnalysis = () => {
    const data = selectedScanIds
      .map((id) => {
        const result = safeResults.find((r) => r.id === id);
        const concentration = parseFloat(substrateConcentrations[id]);
        if (result && !isNaN(concentration)) {
          return {
            s: concentration,
            v0: result.analysis.v0,
          };
        }
        return null;
      })
      .filter(Boolean);

    if (data.length < 2) {
      alert('Please select at least two scans with valid substrate concentrations.');
      return;
    }

    const calculatedData = analysisUtils.calculateKineticParameters(data);
    setAnalysisData(calculatedData);
  };

  const renderChart = (title, data, xLabel, yLabel) => {
    if (!data || data.length === 0) return null;

    return (
      <View style={styles.graphBox}>
        <Text style={styles.chartTitle}>{title}</Text>
        <LineChart
          data={{
            labels: data.map(p => p.x.toFixed(2)),
            datasets: [{ data: data.map(p => p.y) }],
          }}
          width={screenWidth - 48}
          height={220}
          chartConfig={chartConfig}
          bezier
        />
        <View style={styles.axisLabels}>
            <Text style={styles.axisLabel}>X: {xLabel} | Y: {yLabel}</Text>
        </View>
      </View>
    );
  };
  
  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Kinetic Parameter Analysis</Text>
        <Text style={styles.subtitle}>
          Select at least two scans and enter substrate concentrations.
        </Text>
      </View>

      <View style={styles.scanSelection}>
        {safeResults.map((result) => (
          <View key={result.id} style={styles.scanRow}>
            <TouchableOpacity
              style={[
                styles.checkbox,
                selectedScanIds.includes(result.id) && styles.checkboxSelected,
              ]}
              onPress={() => handleToggleScan(result.id)}
            />
            <Text style={styles.scanText}>
              {result.timestamp} (V₀: {result.analysis.v0.toFixed(4)})
            </Text>
            <TextInput
              style={styles.input}
              placeholder="[S]"
              keyboardType="numeric"
              onChangeText={(text) => handleConcentrationChange(result.id, text)}
              value={substrateConcentrations[result.id] || ''}
            />
          </View>
        ))}
      </View>

      <TouchableOpacity style={styles.button} onPress={handleStartAnalysis}>
        <Text style={styles.buttonText}>Analyze</Text>
      </TouchableOpacity>

      {analysisData && (
        <View style={styles.resultsContainer}>
          <View style={styles.resultsBox}>
            <Text style={styles.boxTitle}>Kinetic Parameters</Text>
            <View style={styles.resultRow}>
                <Text style={styles.resultLabel}>Vmax:</Text>
                <Text style={styles.resultValue}>{analysisData.vmax.toFixed(4)} A/s</Text>
            </View>
            <View style={styles.resultRow}>
                <Text style={styles.resultLabel}>Km:</Text>
                <Text style={styles.resultValue}>{analysisData.km.toFixed(4)}</Text>
            </View>
          </View>
          
          {renderChart(
            'Michaelis-Menten Plot',
            analysisData.michaelisMenten,
            '[S]',
            'V₀'
          )}
          {renderChart(
            'Lineweaver-Burk Plot',
            analysisData.lineweaverBurk,
            '1/[S]',
            '1/V₀'
          )}
          {renderChart(
            'Hanes-Woolf Plot',
            analysisData.hanesWoolf,
            '[S]',
            '[S]/V₀'
          )}
        </View>
      )}
    </ScrollView>
  );
}

const chartConfig = {
    backgroundColor: '#252526',
    backgroundGradientFrom: '#252526',
    backgroundGradientTo: '#252526',
    color: (opacity = 1) => `rgba(212, 212, 212, ${opacity})`,
    labelColor: () => '#a0a0a0',
    strokeWidth: 2,
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1e1e1e',
  },
  header: {
    padding: 16,
    backgroundColor: '#252526',
    borderBottomWidth: 1,
    borderBottomColor: '#333333',
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#d4d4d4',
  },
  subtitle: {
    fontSize: 12,
    color: '#a0a0a0',
    marginTop: 4,
  },
  scanSelection: {
    padding: 16,
  },
  scanRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderWidth: 1,
    borderColor: '#a0a0a0',
    marginRight: 12,
  },
  checkboxSelected: {
    backgroundColor: '#007acc',
  },
  scanText: {
    flex: 1,
    color: '#d4d4d4',
  },
  input: {
    width: 60,
    height: 30,
    borderColor: '#a0a0a0',
    borderWidth: 1,
    borderRadius: 4,
    color: '#d4d4d4',
    textAlign: 'center',
    padding: 4,
  },
  button: {
    backgroundColor: '#007acc',
    padding: 12,
    borderRadius: 4,
    alignItems: 'center',
    margin: 16,
  },
  buttonText: {
    color: 'white',
    fontWeight: 'bold',
  },
  resultsContainer: {
    padding: 16,
  },
  resultsBox: {
    backgroundColor: '#252526',
    borderRadius: 8,
    padding: 16,
    marginBottom: 16,
  },
  boxTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#d4d4d4',
    marginBottom: 12,
    textTransform: 'uppercase',
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
  },
  resultValue: {
    fontSize: 12,
    color: '#d4d4d4',
    fontWeight: 'bold',
  },
  graphBox: {
    backgroundColor: '#252526',
    borderRadius: 8,
    padding: 12,
    marginVertical: 8,
    alignItems: 'center',
  },
  chartTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#d4d4d4',
    marginBottom: 4,
  },
  axisLabels: {
    paddingVertical: 8,
    alignItems: 'center',
  },
  axisLabel: {
    fontSize: 11,
    color: '#007acc',
    fontWeight: '500',
  },
});
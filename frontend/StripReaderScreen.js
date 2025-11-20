import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Alert,
  Platform,
  Dimensions,
} from 'react-native';
import { Buffer } from 'buffer';
import * as analysisUtils from './analysisUtils';
import { LineChart } from 'react-native-chart-kit';
import useUsbDevice from './useUsbDevice';

const PROFILES = ['CV', 'LSV', 'SWV', 'AMP', 'OCP'];

const PARAMETERS = {
  CV: {
    startVoltage: { label: 'Start Voltage (V)', defaultValue: '-0.5' },
    vertex1: { label: 'Vertex 1 (V)', defaultValue: '0.5' },
    vertex2: { label: 'Vertex 2 (V)', defaultValue: '-0.5' },
    scanRate: { label: 'Scan Rate (V/s)', defaultValue: '0.1' },
    cycles: { label: 'Cycles', defaultValue: '1' },
  },
  LSV: {
    startVoltage: { label: 'Start Voltage (V)', defaultValue: '-0.5' },
    endVoltage: { label: 'End Voltage (V)', defaultValue: '0.5' },
    scanRate: { label: 'Scan Rate (V/s)', defaultValue: '0.1' },
  },
  SWV: {
    startVoltage: { label: 'Start Voltage (V)', defaultValue: '-1' },
    endVoltage: { label: 'End Voltage (V)', defaultValue: '1' },
    amplitude: { label: 'Amplitude (V)', defaultValue: '0.025' },
    frequency: { label: 'Frequency (Hz)', defaultValue: '10' },
  },
  AMP: {
    voltage: { label: 'Voltage (V)', defaultValue: '0.2' },
    duration: { label: 'Duration (s)', defaultValue: '10' },
    interval: { label: 'Interval (s)', defaultValue: '0.1' },
  },
  OCP: {
    duration: { label: 'Duration (s)', defaultValue: '10' },
  },
};

const screenWidth = Dimensions.get('window').width;

export default function StripReaderScreen() {
  const { isConnected, data, error, connect, disconnect, write } = useUsbDevice(1155, 22336);
  const [connectionStatus, setConnectionStatus] = useState('Disconnected');
  const [selectedProfile, setSelectedProfile] = useState('CV');
  const [parameters, setParameters] = useState(
    Object.keys(PARAMETERS.CV).reduce((acc, key) => {
      acc[key] = PARAMETERS.CV[key].defaultValue;
      return acc;
    }, {})
  );
  const [logs, setLogs] = useState([]);
  const [chartData, setChartData] = useState({
    labels: [],
    datasets: [{ data: [] }],
  });
  const [isAwaitingAck, setIsAwaitingAck] = useState(false);
  const [isMining, setIsMining] = useState(false);
  const mineIntervalId = useRef(null);
  const scrollViewRef = useRef();

  useEffect(() => {
    if (isConnected) {
      setConnectionStatus('Connected');
      addLog('Device connected');
    } else {
      setConnectionStatus('Disconnected');
      addLog('Device disconnected');
    }
  }, [isConnected]);

  useEffect(() => {
    if (data) {
      const result = analysisUtils.parseDevicePacket(data);
      if (result.type === 'data') {
        addLog(`RX (Data): ${JSON.stringify(result.payload)}`);
        setChartData((prev) => {
          const newLabels = [...prev.labels, result.payload.x.toFixed(2)];
          const newData = [...prev.datasets[0].data, result.payload.y];
          return {
            labels: newLabels,
            datasets: [{ data: newData }],
          };
        });
      } else if (result.type === 'status') {
        addLog(`RX (Status): ${result.payload}`);
        if (isAwaitingAck && result.payload === '6b4e04f401000064') {
          setIsAwaitingAck(false);
          sendScanCommand();
        }
      } else {
        addLog(`RX (Unknown): ${result.payload}`);
      }
    }
  }, [data, isAwaitingAck]);

  useEffect(() => {
    if (error) {
      addLog(`Error: ${error}`);
    }
  }, [error]);

  const addLog = (message) => {
    const logMessage = `[${new Date().toLocaleTimeString()}] ${message}`;
    setLogs((prev) => [logMessage, ...prev]);
    // Also print RX messages to the main console for better visibility
    if (message.startsWith('RX')) {
      console.log(message);
    }
  };

  const handleProfileChange = (profile) => {
    setSelectedProfile(profile);
    setParameters(
      Object.keys(PARAMETERS[profile]).reduce((acc, key) => {
        acc[key] = PARAMETERS[profile][key].defaultValue;
        return acc;
      }, {})
    );
  };

  const handleParameterChange = (name, value) => {
    setParameters((prev) => ({ ...prev, [name]: value }));
  };

  const handleConnect = async () => {
    connect();
  };

  const handleDisconnect = async () => {
    disconnect();
  };

  const writeCommand = async (command) => {
    if (!isConnected) {
      Alert.alert('Device not connected');
      return;
    }
    addLog(`TX: ${command.toString('hex')}`);
    await write(command.toString('base64'));
  };

  const handleTestLED = async () => {
    const [handshake1, handshake2] = analysisUtils.getHandshakeCommands();
    await writeCommand(handshake1);
    await new Promise(resolve => setTimeout(resolve, 100)); // Wait 100ms
    await writeCommand(handshake2);
    await new Promise(resolve => setTimeout(resolve, 100)); // Wait 100ms

    const command = analysisUtils.createLEDCommand(true);
    await writeCommand(command);
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second

    const offCommand = analysisUtils.createLEDCommand(false);
    await writeCommand(offCommand);
  };

  const sendScanCommand = () => {
    let scanPacket;
    switch (selectedProfile) {
      case 'CV':
        scanPacket = analysisUtils.createCVPacket(parameters);
        break;
      case 'LSV':
        scanPacket = analysisUtils.createLSVPacket(parameters);
        break;
      case 'SWV':
        scanPacket = analysisUtils.createSWVPacket(parameters);
        break;
      case 'AMP':
        scanPacket = analysisUtils.createAMPPacket(parameters);
        break;
      default:
        addLog(`Profile ${selectedProfile} not implemented yet.`);
        return;
    }
    writeCommand(scanPacket);
  };

  const handleStartScan = async () => {
    const [handshake1, handshake2] = analysisUtils.getHandshakeCommands();
    await writeCommand(handshake1);
    await new Promise(resolve => setTimeout(resolve, 100)); // Wait 100ms
    await writeCommand(handshake2);
    setIsAwaitingAck(true);
  };

  const handleMineCommands = async () => {
    if (isMining) {
      if (mineIntervalId.current) {
        clearInterval(mineIntervalId.current);
        mineIntervalId.current = null;
      }
      setIsMining(false);
      addLog('--- Mining Stopped ---');
      return;
    }

    addLog('--- Starting Command Mining ---');
    setIsMining(true);
    setChartData({ labels: [], datasets: [{ data: [] }] });

    const [handshake1, handshake2] = analysisUtils.getHandshakeCommands();
    await writeCommand(handshake1);
    await new Promise(resolve => setTimeout(resolve, 100));
    await writeCommand(handshake2);
    await new Promise(resolve => setTimeout(resolve, 200));

    let subCommandId = 0;
    mineIntervalId.current = setInterval(() => {
      if (subCommandId > 255) {
        clearInterval(mineIntervalId.current);
        mineIntervalId.current = null;
        setIsMining(false);
        addLog('--- Mining Finished ---');
        return;
      }

      const minePacket = Buffer.alloc(31);
      minePacket.writeUInt8(0x6B, 0);      // Header
      minePacket.writeUInt8(0x0C, 1);      // Main Command ID (Best Guess)
      minePacket.writeUInt8(subCommandId, 2); // The byte we are mining!
      minePacket.writeUInt8(0x00, 3);      // Packet ID
      
      // Hardcoded "safe" parameters
      minePacket.writeFloatLE(-0.2, 4);
      minePacket.writeFloatLE(0.2, 8);
      minePacket.writeFloatLE(-0.2, 12);
      minePacket.writeFloatLE(0.1, 16);
      minePacket.writeUInt8(1, 20);

      for (let i = 21; i < 30; i++) {
        minePacket.writeUInt8(0, i);
      }
      minePacket.writeUInt8(0x8F, 30);    // Original Footer

      writeCommand(minePacket);

      subCommandId++;
    }, 250); // 4 commands per second
  };

  const handleClear = () => {
    setLogs([]);
    setChartData({
      labels: [],
      datasets: [{ data: [] }],
    });
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Strip Reader</Text>
        <View style={styles.connectionBar}>
          <Text style={styles.connectionText}>
            Status: {connectionStatus}
          </Text>
          <TouchableOpacity
            style={[
              styles.connectButton,
              connectionStatus === 'Connected' && styles.connectedButton,
            ]}
            onPress={connectionStatus === 'Connected' ? handleDisconnect : handleConnect}
          >
            <Text style={styles.buttonText}>
              {connectionStatus === 'Connected' ? 'Disconnect' : 'Connect'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView style={styles.content}>
        {chartData.labels.length > 0 && (
          <View style={styles.chartContainer}>
            <LineChart
              data={chartData}
              width={screenWidth - 32}
              height={220}
              chartConfig={chartConfig}
              bezier
            />
          </View>
        )}

        <View style={styles.profileSelector}>
          {PROFILES.map((profile) => (
            <TouchableOpacity
              key={profile}
              style={[
                styles.profileButton,
                selectedProfile === profile && styles.activeProfileButton,
              ]}
              onPress={() => handleProfileChange(profile)}
            >
              <Text style={styles.profileButtonText}>{profile}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.parameterContainer}>
          <Text style={styles.parameterTitle}>{selectedProfile} Parameters</Text>
          {Object.entries(PARAMETERS[selectedProfile]).map(([key, config]) => (
            <View key={key} style={styles.parameterInput}>
              <Text style={styles.parameterLabel}>{config.label}</Text>
              <TextInput
                style={styles.textInput}
                value={parameters[key]}
                onChangeText={(value) => handleParameterChange(key, value)}
                keyboardType="numeric"
              />
            </View>
          ))}
        </View>

        <View style={styles.actionButtons}>
          <TouchableOpacity style={styles.actionButton} onPress={handleTestLED}>
            <Text style={styles.buttonText}>Test LED</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionButton, styles.startButton]}
            onPress={handleStartScan}
          >
            <Text style={styles.buttonText}>Start Scan</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionButton, { backgroundColor: isMining ? '#d16464' : '#5865F2' }]}
            onPress={handleMineCommands}
          >
            <Text style={styles.buttonText}>{isMining ? 'Stop Mining' : 'Mine Commands'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.actionButton} onPress={handleClear}>
            <Text style={styles.buttonText}>Clear</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.logContainer}>
          <Text style={styles.logTitle}>Console</Text>
          <ScrollView style={styles.logView} nestedScrollEnabled={true}>
            {logs.map((log, index) => (
              <Text key={index} style={styles.logText}>
                {log}
              </Text>
            ))}
          </ScrollView>
        </View>
      </ScrollView>
    </View>
  );
}

const chartConfig = {
  backgroundColor: '#1e1e1e',
  backgroundGradientFrom: '#1e1e1e',
  backgroundGradientTo: '#1e1e1e',
  decimalPlaces: 2,
  color: (opacity = 1) => `rgba(255, 255, 255, ${opacity})`,
  labelColor: (opacity = 1) => `rgba(255, 255, 255, ${opacity})`,
  style: {
    borderRadius: 16,
  },
  propsForDots: {
    r: '6',
    strokeWidth: '2',
    stroke: '#ffa726',
  },
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1e1e1e',
  },
  header: {
    backgroundColor: '#252526',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#333',
  },
  title: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#d4d4d4',
    marginBottom: 12,
  },
  connectionBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  connectionText: {
    color: '#a0a0a0',
  },
  connectButton: {
    backgroundColor: '#007acc',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
  },
  connectedButton: {
    backgroundColor: '#d16464',
  },
  buttonText: {
    color: '#fff',
    fontWeight: 'bold',
  },
  content: {
    flex: 1,
    padding: 16,
  },
  chartContainer: {
    marginBottom: 20,
  },
  profileSelector: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginBottom: 20,
  },
  profileButton: {
    paddingVertical: 10,
    paddingHorizontal: 15,
    borderRadius: 6,
    backgroundColor: '#3a3d41',
  },
  activeProfileButton: {
    backgroundColor: '#007acc',
  },
  profileButtonText: {
    color: '#fff',
    fontWeight: '500',
  },
  parameterContainer: {
    marginBottom: 20,
  },
  parameterTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#d4d4d4',
    marginBottom: 10,
  },
  parameterInput: {
    marginBottom: 10,
  },
  parameterLabel: {
    color: '#a0a0a0',
    marginBottom: 5,
  },
  textInput: {
    backgroundColor: '#252526',
    color: '#d4d4d4',
    padding: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#333',
  },
  actionButtons: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginBottom: 20,
  },
  actionButton: {
    backgroundColor: '#3a3d41',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 6,
  },
  startButton: {
    backgroundColor: '#238636',
  },
  logContainer: {
    height: 200,
    backgroundColor: '#252526',
    borderRadius: 6,
    padding: 10,
  },
  logTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#d4d4d4',
    marginBottom: 10,
  },
  logView: {
    flex: 1,
  },
  logText: {
    color: '#a0a0a0',
    fontFamily: 'monospace',
    fontSize: 12,
  },
});




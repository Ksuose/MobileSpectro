import { useState, useEffect } from 'react';
import { NativeModules, NativeEventEmitter } from 'react-native';

const { UsbGalvanoPlotModule } = NativeModules;
const usbEventEmitter = new NativeEventEmitter(UsbGalvanoPlotModule);

const useUsbDevice = (vendorId, productId) => {
  const [isConnected, setIsConnected] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const onConnectionChange = (event) => {
      setIsConnected(event.isConnected);
      if (event.error) {
        setError(event.error);
      }
    };

    const onDataReceived = (event) => {
      setData(event.data);
    };

    const connectionSubscription = usbEventEmitter.addListener('onUsbConnectionChange', onConnectionChange);
    const dataSubscription = usbEventEmitter.addListener('onUsbDataReceived', onDataReceived);

    return () => {
      connectionSubscription.remove();
      dataSubscription.remove();
    };
  }, []);

  const connect = () => {
    UsbGalvanoPlotModule.connect(vendorId, productId)
      .then(() => {
        // Connection successful
      })
      .catch((e) => {
        setError(e.message);
      });
  };

  const disconnect = () => {
    UsbGalvanoPlotModule.disconnect()
      .then(() => {
        // Disconnection successful
      })
      .catch((e) => {
        setError(e.message);
      });
  };

  const write = (base64Data) => {
    return UsbGalvanoPlotModule.write(base64Data);
  };

  return { isConnected, data, error, connect, disconnect, write };
};

export default useUsbDevice;

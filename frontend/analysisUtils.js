import { Buffer } from 'buffer';
/**
 * On-device analysis utilities for dual-ROI enzyme kinetics.
 * This version restores the core drift-correction logic.
 */

/**
 * Calculates drift-corrected absorbance using the Beer-Lambert law.
 * A = -log10(I_sample / I_blank)
 * The 'reference' ROI values are used to correct for fluctuations
 * in the light source, creating a more stable signal.
 *
 * @param {object} sampleRGB - {r, g, b} of the sample ROI.
 * @param {object} blankSampleRGB - {r, g, b} of the sample ROI during blanking.
 * @param {object} referenceRGB - {r, g, b} of the reference ROI.
 * @param {object} blankReferenceRGB - {r, g, b} of the reference ROI during blanking.
 * @returns {object} Corrected absorbance values {r, g, b}.
 */
export const calculateAbsorbance = (sampleRGB, blankSampleRGB, referenceRGB, blankReferenceRGB) => {
  const epsilon = 1e-9; // Avoid division by zero

  // Correct the current sample reading by the change in the reference light source
  const correctedR = sampleRGB.r * (blankReferenceRGB.r / Math.max(referenceRGB.r, epsilon));
  const correctedG = sampleRGB.g * (blankReferenceRGB.g / Math.max(referenceRGB.g, epsilon));
  const correctedB = sampleRGB.b * (blankReferenceRGB.b / Math.max(referenceRGB.b, epsilon));

  // Calculate absorbance using the corrected sample value and the initial blank
  // Beer-Lambert: A = log10(I0/I) where I0=blank, I=corrected sample
  let absR = -Math.log10(Math.max(correctedR / blankSampleRGB.r, epsilon));
  let absG = -Math.log10(Math.max(correctedG / blankSampleRGB.g, epsilon));
  let absB = -Math.log10(Math.max(correctedB / blankSampleRGB.b, epsilon));

  // Clamp to 0: if absorbance goes negative (sample > blank), physically it means no absorption
  // This can occur due to noise or calibration drift. Zero is the lower bound.
  absR = Math.max(0, absR);
  absG = Math.max(0, absG);
  absB = Math.max(0, absB);

  return { r: absR, g: absG, b: absB };
};

export function analyzeKineticData(absorbanceData) {
  if (!Array.isArray(absorbanceData) || absorbanceData.length < 5) {
    throw new Error('Not enough data points for analysis.');
  }

  const channels = ['r', 'g', 'b'];
  let bestFit = { r_squared: -Infinity, v0: 0, primaryChannel: 'none', startTime: null, endTime: null, phases: [] };

  for (const channel of channels) {
    const data = absorbanceData
      .filter(d => d && d.time != null && d.abs && typeof d.abs[channel] === 'number')
      .map(d => ({ x: d.time, y: d.abs[channel] }));

    if (data.length < 5) {
      continue;
    }

    const windowSize = Math.max(5, Math.floor(data.length * 0.25));
    let bestWindow = { r_squared: -Infinity, slope: 0, startTime: 0, endTime: 0 };

    // To ensure we find the *initial* rate, we limit the search to the first 40% of the data points.
    const searchLimit = Math.floor(data.length * 0.4);

    for (let i = 0; i <= searchLimit && i <= data.length - windowSize; i++) {
      const windowData = data.slice(i, i + windowSize);
      const x = windowData.map(p => p.x);
      const y = windowData.map(p => p.y);
      const lr = linearRegression(x, y);

      if (lr.r_squared > bestWindow.r_squared) {
        bestWindow = {
          r_squared: lr.r_squared,
          slope: lr.slope,
          startTime: windowData[0].x,
          endTime: windowData[windowData.length - 1].x,
        };
      }
    }
      
    if (bestWindow.r_squared > bestFit.r_squared) {
      bestFit = {
        v0: bestWindow.slope,
        r_squared: bestWindow.r_squared,
        primaryChannel: channel,
        startTime: bestWindow.startTime,
        endTime: bestWindow.endTime,
        phases: [{
          name: 'Initial Rate',
          timeStart: bestWindow.startTime.toFixed(2),
          timeEnd: bestWindow.endTime.toFixed(2),
          slope: bestWindow.slope,
          r_squared: bestWindow.r_squared,
        }]
      };
    }
  }

  return bestFit;
}

export function prepareChartData(absorbanceData) {
  const chartTime = absorbanceData.map((d) => d.time);
  const chartR = absorbanceData.map((d) => d.abs.r);
  const chartG = absorbanceData.map((d) => d.abs.g);
  const chartB = absorbanceData.map((d) => d.abs.b);
  return { chartTime, chartR, chartG, chartB };
}

function linearRegression(x, y) {
  const n = x.length;
  if (n < 2) {
    return { slope: 0, intercept: 0, r_squared: 0 };
  }
  let sum_x = 0;
  let sum_y = 0;
  let sum_xy = 0;
  let sum_xx = 0;
  let sum_yy = 0;

  for (let i = 0; i < n; i++) {
    sum_x += x[i];
    sum_y += y[i];
    sum_xy += x[i] * y[i];
    sum_xx += x[i] * x[i];
    sum_yy += y[i] * y[i];
  }

  const denominator = (n * sum_xx - sum_x * sum_x);
  if (denominator === 0) {
    return { slope: 0, intercept: 0, r_squared: 0 };
  }


  const slope = (n * sum_xy - sum_x * sum_y) / denominator;
  const intercept = (sum_y - slope * sum_x) / n;
  const r_squared = Math.pow(
    (n * sum_xy - sum_x * sum_y) /
      Math.sqrt((n * sum_xx - sum_x * sum_x) * (n * sum_yy - sum_y * sum_y)),
    2
  );

  return { slope, intercept, r_squared: isNaN(r_squared) ? 0 : r_squared };
}

export function calculateKineticParameters(data) {
    if (data.length < 2) {
        return {
            vmax: 0,
            km: 0,
            michaelisMenten: [],
            lineweaverBurk: [],
            hanesWoolf: [],
        };
    }

    const michaelisMenten = data.map(d => ({ x: d.s, y: d.v0 }));
    let validMethods = 0;
    let total_vmax = 0;
    let total_km = 0;

    // Lineweaver-Burk
    const lineweaverBurkData = data.filter(d => d.s > 0 && d.v0 > 0).map(d => ({ x: 1 / d.s, y: 1 / d.v0 }));
    if (lineweaverBurkData.length > 1) {
        const lb_lr = linearRegression(lineweaverBurkData.map(p => p.x), lineweaverBurkData.map(p => p.y));
        if (lb_lr.intercept !== 0) {
            const lb_vmax = 1 / lb_lr.intercept;
            const lb_km = lb_lr.slope * lb_vmax;
            if (isFinite(lb_vmax) && isFinite(lb_km)) {
                total_vmax += lb_vmax;
                total_km += lb_km;
                validMethods++;
            }
        }
    }

    // Hanes-Woolf
    const hanesWoolfData = data.filter(d => d.s > 0 && d.v0 > 0).map(d => ({ x: d.s, y: d.s / d.v0 }));
    if (hanesWoolfData.length > 1) {
        const hw_lr = linearRegression(hanesWoolfData.map(p => p.x), hanesWoolfData.map(p => p.y));
        if (hw_lr.slope !== 0) {
            const hw_vmax = 1 / hw_lr.slope;
            const hw_km = hw_lr.intercept * hw_vmax;
            if (isFinite(hw_vmax) && isFinite(hw_km)) {
                total_vmax += hw_vmax;
                total_km += hw_km;
                validMethods++;
            }
        }
    }

    return {
        vmax: validMethods > 0 ? total_vmax / validMethods : 0,
        km: validMethods > 0 ? total_km / validMethods : 0,
        michaelisMenten,
        lineweaverBurk: lineweaverBurkData,
                hanesWoolf: hanesWoolfData,
            };
        }
        
        // Packet Parser
        export const parseDevicePacket = (base64String) => {
          const buffer = Buffer.from(base64String, 'base64');
          const x = buffer.readFloatLE(4);
          const y = buffer.readFloatLE(8);
          return { x, y };
        };
        
        // Command Builders
        export const createLEDCommand = (isOn) => {
          const buffer = Buffer.alloc(5);
          buffer.writeUInt8(0x6B, 0);
          buffer.writeUInt8(0x0C, 1);
          buffer.writeUInt8(isOn ? 1 : 0, 2);
          buffer.writeUInt8(0x00, 3);
          buffer.writeUInt8(0x8F, 4);
          return buffer;
        };
        
        export const getHandshakeCommands = () => {
          const handshake1 = Buffer.from([0x6B, 0x67, 0x01, 0x8F]);
          const handshake2 = Buffer.from([0x6B, 0x66, 0x01, 0x8F]);
          return [handshake1, handshake2];
        };
        
        export const createCVPacket = (params) => {
          const buffer = Buffer.alloc(31);
          buffer.writeUInt8(0x6B, 0);
          buffer.writeUInt8(0x01, 1); // Command ID placeholder
          buffer.writeUInt8(0x00, 2); // Command ID placeholder
          buffer.writeUInt8(0x00, 3); // Packet ID
          buffer.writeFloatLE(parseFloat(params.startVoltage), 4);
          buffer.writeFloatLE(parseFloat(params.vertex1), 8);
          buffer.writeFloatLE(parseFloat(params.vertex2), 12);
          buffer.writeFloatLE(parseFloat(params.scanRate), 16);
          buffer.writeUInt8(parseInt(params.cycles), 20);
          // Fill the rest with zeros, then the footer
          for (let i = 21; i < 30; i++) {
            buffer.writeUInt8(0, i);
          }
            buffer.writeUInt8(0x8F, 30);
            return buffer;
          };
          
          export const createLSVPacket = (params) => {
            const buffer = Buffer.alloc(29);
            buffer.writeUInt8(0x6B, 0);
            buffer.writeUInt8(0x02, 1); // Command ID placeholder
            buffer.writeUInt8(0x00, 2); // Command ID placeholder
            buffer.writeUInt8(0x00, 3); // Packet ID
            buffer.writeFloatLE(parseFloat(params.startVoltage), 4);
            buffer.writeFloatLE(parseFloat(params.endVoltage), 8);
            buffer.writeFloatLE(parseFloat(params.scanRate), 12);
            // Fill the rest with zeros, then the footer
            for (let i = 16; i < 28; i++) {
              buffer.writeUInt8(0, i);
            }
            buffer.writeUInt8(0x8F, 28);
            return buffer;
          };
          
          export const createSWVPacket = (params) => {
            const buffer = Buffer.alloc(29);
            buffer.writeUInt8(0x6B, 0);
            buffer.writeUInt8(0x03, 1); // Command ID placeholder
            buffer.writeUInt8(0x00, 2); // Command ID placeholder
            buffer.writeUInt8(0x00, 3); // Packet ID
            buffer.writeFloatLE(parseFloat(params.startVoltage), 4);
            buffer.writeFloatLE(parseFloat(params.endVoltage), 8);
            buffer.writeFloatLE(parseFloat(params.amplitude), 12);
            buffer.writeFloatLE(parseFloat(params.frequency), 16);
            // Fill the rest with zeros, then the footer
            for (let i = 20; i < 28; i++) {
              buffer.writeUInt8(0, i);
            }
            buffer.writeUInt8(0x8F, 28);
            return buffer;
          };
          
          export const createAMPPacket = (params) => {
            const buffer = Buffer.alloc(27);
            buffer.writeUInt8(0x6B, 0);
            buffer.writeUInt8(0x04, 1); // Command ID placeholder
            buffer.writeUInt8(0x00, 2); // Command ID placeholder
            buffer.writeUInt8(0x00, 3); // Packet ID
            buffer.writeFloatLE(parseFloat(params.voltage), 4);
            buffer.writeFloatLE(parseFloat(params.duration), 8);
            buffer.writeFloatLE(parseFloat(params.interval), 12);
            // Fill the rest with zeros, then the footer
            for (let i = 16; i < 26; i++) {
              buffer.writeUInt8(0, i);
            }
            buffer.writeUInt8(0x8F, 26);
            return buffer;
          };
          
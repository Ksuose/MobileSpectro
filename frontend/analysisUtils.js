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

/**
 * Extracts the average RGB values from a specified ROI in image data.
 * @param {Uint8ClampedArray} imageData - The raw pixel data from the canvas.
 * @param {number} width - The width of the canvas/image.
 * @param {number} x - The starting x-coordinate of the ROI.
 * @param {number} y - The starting y-coordinate of the ROI.
 * @param {number} w - The width of the ROI.
 * @param {number} h - The height of the ROI.
 * @returns {object} Average RGB values {r, g, b}.
 */
export const getAverageRGB = (imageData, width, x, y, w, h) => {
  let r = 0, g = 0, b = 0;
  let count = 0;
  
  // Ensure ROI is within bounds
  const startX = Math.floor(Math.max(0, x));
  const startY = Math.floor(Math.max(0, y));
  const endX = Math.floor(Math.min(width, x + w));
  const endY = Math.floor(Math.min(imageData.length / (4 * width), y + h));

  for (let j = startY; j < endY; j++) {
    for (let i = startX; i < endX; i++) {
      const index = (j * width + i) * 4;
      r += imageData[index];
      g += imageData[index + 1];
      b += imageData[index + 2];
      count++;
    }
  }

  if (count === 0) return { r: 0, g: 0, b: 0 };
  
  return { r: r / count, g: g / count, b: b / count };
};

// --- Kinetic Analysis functions (V0, R-squared, etc.) ---

export const smoothData = (data, windowSize = 5) => {
  if (data.length < windowSize) return data;
  const smoothed = [];
  for (let i = 0; i < data.length; i++) {
    const start = Math.max(0, i - Math.floor(windowSize / 2));
    const end = Math.min(data.length, i + Math.floor(windowSize / 2) + 1);
    const sum = data.slice(start, end).reduce((a, b) => a + b, 0);
    smoothed.push(sum / (end - start));
  }
  return smoothed;
};

const calculateRSquared = (actual, predicted) => {
  const mean = actual.reduce((a, b) => a + b, 0) / actual.length;
  const ssTotal = actual.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0);
  const ssRes = actual.reduce((sum, val, i) => sum + Math.pow(val - predicted[i], 2), 0);
  if (ssTotal < 1e-9) return ssRes < 1e-9 ? 1.0 : 0.0;
  return Math.max(0, 1 - (ssRes / ssTotal));
};

export const linearRegression = (xData, yData) => {
  if (xData.length < 2) return { slope: 0, intercept: 0, r_squared: 0 };
  const n = xData.length;
  const sumX = xData.reduce((a, b) => a + b, 0);
  const sumY = yData.reduce((a, b) => a + b, 0);
  const sumXY = xData.reduce((sum, x, i) => sum + x * yData[i], 0);
  const sumX2 = xData.reduce((sum, x) => sum + x * x, 0);
  
  const denominator = (n * sumX2 - sumX * sumX);
  if (Math.abs(denominator) < 1e-9) return { slope: 0, intercept: 0, r_squared: 0 };

  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;
  
  const predicted = xData.map(x => slope * x + intercept);
  const r_squared = calculateRSquared(yData, predicted);
  
  return { slope, intercept, r_squared };
};

export const findBestLinearSegment = (timeData, absDataRaw, minPoints = 5) => {
  const n = timeData.length;
  if (n < minPoints) {
    return linearRegression(timeData, absDataRaw);
  }

  const absDataSmooth = smoothData(absDataRaw, 5);
  let bestSlope = 0;
  let bestR2 = -1.0;
  let bestStartIdx = 0;
  let bestEndIdx = minPoints - 1;

  // Sliding window to find the most linear segment for V0
  for (let i = 0; i <= n - minPoints; i++) {
    for (let j = i + minPoints - 1; j < n; j++) {
      const timeSegment = timeData.slice(i, j + 1);
      const smoothSegment = absDataSmooth.slice(i, j + 1);
      const rawSegment = absDataRaw.slice(i, j + 1);

      const model = linearRegression(timeSegment, smoothSegment);
      
      const predictedRaw = timeSegment.map(x => model.slope * x + model.intercept);
      const r2_raw = calculateRSquared(rawSegment, predictedRaw);

      if (r2_raw > bestR2) {
        bestR2 = r2_raw;
        bestSlope = model.slope;
        bestStartIdx = i;
        bestEndIdx = j;
      }
    }
  }
  
  return { slope: bestSlope, r_squared: bestR2, startIdx: bestStartIdx, endIdx: bestEndIdx };
};

export const analyzeKineticData = (absorbanceData) => {
  const timeData = absorbanceData.map(d => d.time);
  const rData = absorbanceData.map(a => a.abs.r);
  const gData = absorbanceData.map(a => a.abs.g);
  const bData = absorbanceData.map(a => a.abs.b);
  
  const rChange = Math.abs(rData[rData.length - 1] - rData[0]);
  const gChange = Math.abs(gData[gData.length - 1] - gData[0]);
  const bChange = Math.abs(bData[bData.length - 1] - bData[0]);
  
  const changes = { r: rChange, g: gChange, b: bChange };
  const primaryChannel = Object.keys(changes).reduce((a, b) => changes[a] > changes[b] ? a : b);
  
  const primaryData = primaryChannel === 'r' ? rData : primaryChannel === 'g' ? gData : bData;
  
  const analysis = findBestLinearSegment(timeData, primaryData, 5);
  
  const midPoint = Math.floor(timeData.length / 2);
  const phase1Start = timeData[0];
  const phase1End = timeData[Math.min(midPoint, timeData.length - 1)];
  const phase2Start = timeData[midPoint];
  const phase2End = timeData[timeData.length - 1];
  
  const phase1 = linearRegression(timeData.slice(0, midPoint), primaryData.slice(0, midPoint));
  const phase2 = linearRegression(timeData.slice(midPoint), primaryData.slice(midPoint));

  return {
    v0: Math.abs(analysis.slope),
    r_squared: analysis.r_squared,
    primaryChannel,
    startTime: timeData[analysis.startIdx],
    endTime: timeData[analysis.endIdx],
    phases: [
      { 
        name: 'Phase 1 (Initial)', 
        slope: Math.abs(phase1.slope), 
        r_squared: phase1.r_squared,
        timeStart: phase1Start.toFixed(2),
        timeEnd: phase1End.toFixed(2),
      },
      { 
        name: 'Phase 2 (Final)', 
        slope: Math.abs(phase2.slope), 
        r_squared: phase2.r_squared,
        timeStart: phase2Start.toFixed(2),
        timeEnd: phase2End.toFixed(2),
      },
    ],
  };
};

export const prepareChartData = (absorbanceData, maxPoints = 50) => {
  const indices = [];
  if (absorbanceData.length <= maxPoints) {
    for (let i = 0; i < absorbanceData.length; i++) indices.push(i);
  } else {
    const step = Math.ceil(absorbanceData.length / maxPoints);
    for (let i = 0; i < absorbanceData.length; i += step) {
      indices.push(i);
    }
  }
  
  const chartTime = indices.map(i => absorbanceData[i].time);
  const chartR = indices.map(i => absorbanceData[i].abs.r);
  const chartG = indices.map(i => absorbanceData[i].abs.g);
  const chartB = indices.map(i => absorbanceData[i].abs.b);
  
  return { chartTime, chartR, chartG, chartB };
};

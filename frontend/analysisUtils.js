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
  if (absorbanceData.length < 5) {
    throw new Error('Not enough data points for analysis.');
  }

  const channels = ['r', 'g', 'b'];
  let bestFit = { r_squared: -Infinity };

  channels.forEach(channel => {
    const data = absorbanceData.map(d => ({ x: d.time, y: d.abs[channel] }));
    
    // Attempt to find the most linear region for V0 calculation.
    // This looks for the best R^2 from a moving window of points.
    const windowSize = Math.max(5, Math.floor(data.length * 0.25));
    let bestWindow = { r_squared: -Infinity, slope: 0, startTime: 0, endTime: 0 };

    for (let i = 0; i <= data.length - windowSize; i++) {
        const window = data.slice(i, i + windowSize);
        const lr = linearRegression(window.map(p => p.x), window.map(p => p.y));
        if (lr.r_squared > bestWindow.r_squared) {
            bestWindow = {
                r_squared: lr.r_squared,
                slope: lr.slope,
                startTime: window[0].x,
                endTime: window[window.length - 1].x,
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
            phases: [{ // Simplified to a single phase representing the initial rate
                name: 'Initial Rate',
                timeStart: bestWindow.startTime.toFixed(2),
                timeEnd: bestWindow.endTime.toFixed(2),
                slope: bestWindow.slope,
                r_squared: bestWindow.r_squared,
            }]
        };
    }
  });

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

  const slope = (n * sum_xy - sum_x * sum_y) / (n * sum_xx - sum_x * sum_x);
  const intercept = (sum_y - slope * sum_x) / n;
  const r_squared = Math.pow(
    (n * sum_xy - sum_x * sum_y) /
      Math.sqrt((n * sum_xx - sum_x * sum_x) * (n * sum_yy - sum_y * sum_y)),
    2
  );

  return { slope, intercept, r_squared };
}

export function calculateKineticParameters(data) {
    // Michaelis-Menten
    // For simplicity, this is not a non-linear fit but an estimation.
    // A proper implementation would use a non-linear regression library.
    const vmax = Math.max(...data.map(d => d.v0));
    const km = data.find(d => d.v0 >= vmax / 2)?.s || 0;

    const michaelisMenten = data.map(d => ({x: d.s, y: d.v0}));

    // Lineweaver-Burk
    const lineweaverBurkData = data.filter(d => d.s > 0 && d.v0 > 0).map(d => ({ x: 1 / d.s, y: 1 / d.v0 }));
    const lb_lr = linearRegression(lineweaverBurkData.map(p => p.x), lineweaverBurkData.map(p => p.y));
    const lb_vmax = 1 / lb_lr.intercept;
    const lb_km = lb_lr.slope * lb_vmax;

    // Hanes-Woolf
    const hanesWoolfData = data.filter(d => d.s > 0 && d.v0 > 0).map(d => ({ x: d.s, y: d.s / d.v0 }));
    const hw_lr = linearRegression(hanesWoolfData.map(p => p.x), hanesWoolfData.map(p => p.y));
    const hw_vmax = 1 / hw_lr.slope;
    const hw_km = hw_lr.intercept * hw_vmax;
    
    return {
        vmax: (lb_vmax + hw_vmax) / 2, // Average of the two linear methods
        km: (lb_km + hw_km) / 2,
        michaelisMenten,
        lineweaverBurk: lineweaverBurkData,
        hanesWoolf: hanesWoolfData,
    };
}
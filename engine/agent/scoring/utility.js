/**
 * utility.js
 * Mathematical primitives for Utility Theory AI.
 */

// Sigmoid function: Maps input x to 0.0 - 1.0
// x: input value
// k: steepness (higher = steeper)
// x0: midpoint (where y = 0.5)
export function sigmoid(x, k = 0.1, x0 = 50) {
    return 1 / (1 + Math.exp(-k * (x - x0)));
}

// Normalized Linear: Maps min-max to 0.0 - 1.0
export function normalize(val, min, max) {
    return Math.max(0, Math.min(1, (val - min) / (max - min)));
}

// Exponential Urgency: Explosive growth as deadline approaches
export function urgency(timeLeft, buffer = 0) {
    // Prevent division by zero/negative
    const safeTime = Math.max(0.1, timeLeft + buffer); 
    // Invert: Lower time = Higher urgency
    // Scaling factor 10 to make the curve usable
    return Math.min(10, 100 / safeTime);
}

// Maslow's Hierarchy Multipliers
// Used to weight different types of actions
export const MASLOW = {
    PHYSIOLOGICAL: 1000, // Breathing, food, water, sleep, homeostasis
    SAFETY: 500,         // Security of body, employment, resources
    LOVE: 100,           // Friendship, family, intimacy
    ESTEEM: 50,          // Confidence, achievement, respect
    SELF_ACTUALIZATION: 10 // Morality, creativity, problem solving
};
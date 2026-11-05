/** Shared durations for user-triggered motion; streaming content has no entrance animation. */
export const MOTION = Object.freeze({ press: 100, enter: 160, exit: 120, layout: 240, navigation: 240 });
export { MotionPreferenceProvider as MotionProvider, useReduceMotion as useMotionPreference } from './useReduceMotion';

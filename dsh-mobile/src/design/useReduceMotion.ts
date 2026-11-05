/** One system subscription for the app, including legacy looping indicators. */
import React, { createContext, useContext, useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

// Remain still until the system preference is known, including isolated mounts.
const MotionPreference = createContext(true);

export function MotionPreferenceProvider({ children }: { children: React.ReactNode }) {
  const [reduce, setReduce] = useState(true);
  useEffect(() => {
    let alive = true;
    let changed = false;
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', enabled => {
      changed = true;
      if (alive) setReduce(enabled);
    });
    void AccessibilityInfo.isReduceMotionEnabled().then(enabled => {
      // A late initial read must not overwrite a newer accessibility event.
      if (alive && !changed) setReduce(enabled);
    }).catch(() => { if (alive && !changed) setReduce(false); });
    return () => { alive = false; subscription.remove(); };
  }, []);
  return React.createElement(MotionPreference.Provider, { value: reduce }, children);
}

export function useReduceMotion(): boolean {
  return useContext(MotionPreference);
}

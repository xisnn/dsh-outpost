/**
 * 尊重系统「减少动态效果」设置。
 *
 * 返回 true 时，循环动画（思考点、工具执行脉冲、扫码线）应停止并保持静态。
 */
import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

export function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);

  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (alive) setReduce(enabled);
      })
      .catch(() => {
        // 平台不支持时按「不减少」处理
      });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (enabled) => {
      if (alive) setReduce(enabled);
    });
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);

  return reduce;
}

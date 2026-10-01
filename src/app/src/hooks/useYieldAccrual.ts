import { useEffect, useState } from 'react';

export function useYieldAccrual(): number {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const fast = setInterval(() => setTick(t => t + 1), 90);
    return () => clearInterval(fast);
  }, []);

  return tick;
}

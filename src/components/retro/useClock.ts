import { useEffect, useState } from 'react';

const FMT: Intl.DateTimeFormatOptions = {
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
};

export function useClock(): string {
  const [t, setT] = useState(() => new Date().toLocaleTimeString('en-US', FMT));
  useEffect(() => {
    const id = setInterval(() => setT(new Date().toLocaleTimeString('en-US', FMT)), 15_000);
    return () => clearInterval(id);
  }, []);
  return t;
}

export default useClock;

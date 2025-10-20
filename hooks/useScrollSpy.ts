import { useState, useEffect, useRef } from 'react';

export const useScrollSpy = (
  ids: string[],
  options: IntersectionObserverInit = { rootMargin: '0% 0% -60% 0%' }
): string | null => {
  const [activeId, setActiveId] = useState<string | null>(null);
  const observer = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    const elements = ids.map(id => document.getElementById(id)).filter(el => el);
    if (elements.length === 0) return;

    if (observer.current) {
      observer.current.disconnect();
    }

    const handleIntersect: IntersectionObserverCallback = (entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          setActiveId(entry.target.id);
        }
      });
    };
    
    observer.current = new IntersectionObserver(handleIntersect, options);
    elements.forEach(el => observer.current?.observe(el!));

    return () => observer.current?.disconnect();
  }, [ids, options]);

  return activeId;
};

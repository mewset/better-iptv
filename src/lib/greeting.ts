export type Greeting = 'Good morning' | 'Good afternoon' | 'Good evening';

/** Time-of-day greeting from the local clock: 05–11 morning, 12–17 afternoon, else evening. */
export function greeting(now: Date): Greeting {
  const hour = now.getHours();
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 18) return 'Good afternoon';
  return 'Good evening';
}

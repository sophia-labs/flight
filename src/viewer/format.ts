export function formatTime(seconds: number): string {
  return `${seconds.toFixed(1)}s`;
}

export function formatSpeed(metersPerSecond: number): string {
  return `${Math.round(metersPerSecond * 1.94384)} kt`;
}

export function formatAltitude(meters: number): string {
  return `${Math.round(meters)} m`;
}

export function formatAngle(degrees: number): string {
  return `${degrees.toFixed(1)} deg`;
}

export function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

/**
 * The bound every caller-supplied delay is checked against before it reaches a timer.
 * This module imports nothing, so the browser-safe `@pipelex/sdk/upload` entry can use it.
 */

/**
 * The longest delay `setTimeout` honours, in milliseconds. A longer one overflows, and
 * Node and browsers alike then fire the timer almost at once.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Whether `value` is a delay a timer honours: a positive, finite number no larger than the cap. */
export function isTimerDelay(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= MAX_TIMER_DELAY_MS;
}

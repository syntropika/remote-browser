/** Native event sources cannot await a task, so every rejection needs an observer. */
export function background(
  task: Promise<unknown>,
  onFailure: (cause: unknown) => void = console.error,
): void {
  task.catch(onFailure);
}

export function asyncHandler<A extends unknown[]>(
  operation: (...args: A) => Promise<unknown>,
): (...args: A) => void {
  return (...args) => {
    background(operation(...args));
  };
}

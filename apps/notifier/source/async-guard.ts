export type AsyncErrorReporter = (CaughtError: unknown) => void

export function RunGuarded(Operation: () => Promise<void>, ReportError: AsyncErrorReporter): void {
  void Operation().catch(ReportError)
}
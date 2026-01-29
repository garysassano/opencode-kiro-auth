interface RetryConfig {
  max_request_iterations: number
  request_timeout_ms: number
}

interface RetryContext {
  iterations: number
  startTime: number
}

export class RetryStrategy {
  constructor(
    private config: RetryConfig,
    private maxIterations: number,
    private timeoutMs: number
  ) {}

  shouldContinue(context: RetryContext): { canContinue: boolean; error?: string } {
    context.iterations++

    if (context.iterations > this.maxIterations) {
      return {
        canContinue: false,
        error: `Exceeded max iterations (${this.maxIterations})`
      }
    }

    if (Date.now() - context.startTime > this.timeoutMs) {
      return {
        canContinue: false,
        error: 'Request timeout'
      }
    }

    return { canContinue: true }
  }

  createContext(): RetryContext {
    return {
      iterations: 0,
      startTime: Date.now()
    }
  }
}

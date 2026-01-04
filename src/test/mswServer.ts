import { setupServer } from 'msw/node'

// Start with no handlers; each test can register what it needs via server.use(...).
export const server = setupServer()

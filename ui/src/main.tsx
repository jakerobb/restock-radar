import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import StatusPage from './components/StatusPage'
import './index.css'

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } } })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {window.location.pathname.replace(/\/+$/, '') === '/status' ? <StatusPage /> : <App />}
    </QueryClientProvider>
  </StrictMode>,
)

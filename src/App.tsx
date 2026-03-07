import { AppProviders } from './context/AppProviders'
import { AppLayout } from './components/AppLayout'

export default function App() {
    return (
        <AppProviders>
            <AppLayout />
        </AppProviders>
    )
}

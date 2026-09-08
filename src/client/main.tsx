import '@mantine/core/styles.css';

import { Center, Loader, MantineProvider, createTheme } from '@mantine/core';
import { StrictMode, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { api, type Session } from './api';
import { useRouter } from './router';
import { Shell } from './Shell';
import { HomePage, NewRecordPage, RecordPage, SearchPage, TablePage } from './pages';

const theme = createTheme({
  primaryColor: 'indigo',
  defaultRadius: 'md',
  headings: { fontWeight: '650' },
});

function App(): ReactNode {
  const { route, navigate } = useRouter();
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    void api
      .session()
      .then(setSession)
      // Not signed in, or the session has gone: the server owns that page.
      .catch(() => window.location.assign('/login'));
  }, []);

  if (!session) {
    return (
      <Center h="100vh">
        <Loader size="sm" />
      </Center>
    );
  }

  return (
    <Shell session={session} route={route} navigate={navigate}>
      {route.kind === 'home' && <HomePage session={session} navigate={navigate} />}
      {route.kind === 'table' && <TablePage tableId={route.tableId} navigate={navigate} />}
      {route.kind === 'new' && <NewRecordPage tableId={route.tableId} navigate={navigate} />}
      {route.kind === 'record' && <RecordPage recordId={route.recordId} navigate={navigate} />}
      {route.kind === 'search' && <SearchPage term={route.term} navigate={navigate} />}
    </Shell>
  );
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <MantineProvider theme={theme} defaultColorScheme="auto">
        <App />
      </MantineProvider>
    </StrictMode>,
  );
}

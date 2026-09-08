import {
  ActionIcon,
  Anchor,
  AppShell,
  Box,
  Button,
  Group,
  Tabs,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { Session } from './api';
import { hrefFor, type Route } from './router';

interface ShellProps {
  session: Session;
  route: Route;
  navigate: (route: Route) => void;
  children: ReactNode;
}

/**
 * The user space's frame: a centred global search, sign-out and setup at the
 * far right, and the role's tabs beneath.
 *
 * The setup area has its own frame. Nothing is shared between them on purpose
 * -- an administrator should be able to tell at a glance which one they are
 * looking at.
 */
export function Shell({ session, route, navigate, children }: ShellProps): ReactNode {
  const activeTab = route.kind === 'table' || route.kind === 'new' ? route.tableId : null;

  return (
    <AppShell header={{ height: session.tabs.length > 0 ? 104 : 60 }} padding="lg">
      <AppShell.Header>
        <Group h={60} px="md" wrap="nowrap" gap="md">
          {/* The outer thirds share the leftover space equally, so the search
              sits on the middle of the window rather than the middle of what
              happens to be left after the brand and the links. */}
          <Box style={{ flex: '1 1 0', minWidth: 0 }}>
            <Anchor
              href="/app"
              onClick={(event) => {
                event.preventDefault();
                navigate({ kind: 'home' });
              }}
              underline="never"
              fw={650}
              c="var(--mantine-color-text)"
              style={{ letterSpacing: '-0.02em' }}
            >
              Cumulo
            </Anchor>
          </Box>

          <Box style={{ flex: '0 1 480px', display: 'flex', justifyContent: 'center' }}>
            <GlobalSearch route={route} navigate={navigate} />
          </Box>

          <Group
            gap="xs"
            wrap="nowrap"
            justify="flex-end"
            style={{ flex: '1 1 0', minWidth: 0 }}
          >
            <Text size="sm" c="dimmed" visibleFrom="sm">
              {session.user.username} &middot; {session.role.name}
            </Text>
            {session.role.isAdministrator && (
              <Button component="a" href="/admin" variant="subtle" size="compact-sm">
                Setup
              </Button>
            )}
            <form method="post" action="/logout">
              <Button type="submit" variant="subtle" size="compact-sm" color="gray">
                Sign out
              </Button>
            </form>
          </Group>
        </Group>

        {session.tabs.length > 0 && (
          <Tabs
            value={activeTab}
            onChange={(value) => value && navigate({ kind: 'table', tableId: value })}
            variant="outline"
          >
            <Tabs.List px="md">
              {session.tabs.map((tab) => (
                <Tabs.Tab key={tab.id} value={tab.id}>
                  {tab.label}
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </Tabs>
        )}
      </AppShell.Header>

      <AppShell.Main>{children}</AppShell.Main>
    </AppShell>
  );
}

function GlobalSearch({
  route,
  navigate,
}: {
  route: Route;
  navigate: (route: Route) => void;
}): ReactNode {
  const [term, setTerm] = useState(route.kind === 'search' ? route.term : '');

  // Keep the box in step with the address bar, including the back button.
  useEffect(() => {
    if (route.kind === 'search') setTerm(route.term);
  }, [route]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const query = term.trim();
    if (query) navigate({ kind: 'search', term: query });
  };

  return (
    <form onSubmit={submit} style={{ width: '100%', maxWidth: 480 }}>
      <TextInput
        value={term}
        onChange={(event) => setTerm(event.currentTarget.value)}
        placeholder="Search all records"
        aria-label="Search all records"
        size="sm"
        rightSection={
          <Tooltip label="Search" withArrow>
            <ActionIcon type="submit" variant="subtle" aria-label="Search">
              <SearchIcon />
            </ActionIcon>
          </Tooltip>
        }
      />
    </form>
  );
}

function SearchIcon(): ReactNode {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" strokeLinecap="round" />
    </svg>
  );
}

export { hrefFor };

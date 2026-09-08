import {
  ActionIcon,
  Anchor,
  AppShell,
  Avatar,
  Box,
  Divider,
  Group,
  Menu,
  Stack,
  Tabs,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Session } from './api';
import { hrefFor, type Navigate, type Route } from './router';

interface ShellProps {
  session: Session;
  route: Route;
  navigate: Navigate;
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
            {session.role.isAdministrator && (
              <Tooltip label="Setup" withArrow>
                <ActionIcon
                  component="a"
                  href="/admin"
                  variant="subtle"
                  color="gray"
                  size="lg"
                  aria-label="Setup"
                >
                  <GearIcon />
                </ActionIcon>
              </Tooltip>
            )}
            <UserMenu session={session} />
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

/**
 * Who you are, tucked behind the avatar rather than spelled out along the top.
 *
 * Signing out is still a form post to the server, so the menu item submits a
 * hidden one: the session lives in a cookie the client cannot clear itself.
 */
function UserMenu({ session }: { session: Session }): ReactNode {
  const logout = useRef<HTMLFormElement>(null);

  return (
    <>
      <form method="post" action="/logout" ref={logout} hidden />
      {/* AppShell gives the header its own stacking context, so the dropdown
          needs to sit above it explicitly or page content paints over it. */}
      <Menu shadow="md" width={240} position="bottom-end" withArrow withinPortal zIndex={400}>
        <Menu.Target>
          <UnstyledButton aria-label="Account menu">
            <Avatar color="indigo" radius="xl" size={34}>
              {initials(session.user.username)}
            </Avatar>
          </UnstyledButton>
        </Menu.Target>
        <Menu.Dropdown>
          <Stack gap={2} px="sm" py="xs">
            <Text fw={600} size="sm">
              {session.user.username}
            </Text>
            <Text size="xs" c="dimmed">
              {session.role.name}
            </Text>
          </Stack>
          <Divider />
          {session.role.isAdministrator && (
            <Menu.Item component="a" href="/admin" leftSection={<GearIcon />}>
              Setup
            </Menu.Item>
          )}
          <Menu.Item
            color="red"
            leftSection={<SignOutIcon />}
            onClick={() => logout.current?.requestSubmit()}
          >
            Sign out
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </>
  );
}

/** Up to two letters, from a username that may be one word or several. */
function initials(username: string): string {
  const parts = username.trim().split(/[\s._-]+/).filter(Boolean);
  const [first, second] = parts;
  if (!first) return '?';
  if (!second) return first.slice(0, 2).toUpperCase();
  return (first.slice(0, 1) + second.slice(0, 1)).toUpperCase();
}

function GlobalSearch({
  route,
  navigate,
}: {
  route: Route;
  navigate: Navigate;
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

function GearIcon(): ReactNode {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.35.4.64.73.82H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function SignOutIcon(): ReactNode {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
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

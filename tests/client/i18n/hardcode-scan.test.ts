/**
 * Vitest policy tests for i18n hardcode scanner (scripts/i18n-hardcode-scan.mjs).
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

const scanPath = join(process.cwd(), 'scripts/i18n-hardcode-scan.mjs');

async function loadScanner() {
  return import(scanPath);
}

describe('i18n hardcode scanner', () => {
  it('flags a new hardcoded UI string in a migrated-style snippet', async () => {
    const { scanFileForHardcodedUi } = await loadScanner();
    const src = `
      export function Demo() {
        return <button type="button">Buy more slots now</button>;
      }
    `;
    const findings = scanFileForHardcodedUi('client/src/features/servers/components/Demo.tsx', src);
    expect(findings.some((f) => f.text.includes('Buy more slots'))).toBe(true);
  });

  it('does not flag t() translations', async () => {
    const { scanFileForHardcodedUi } = await loadScanner();
    const src = `
      const t = (k) => k;
      export function Demo() {
        return <button type="button">{t('servers.room.newSlot')}</button>;
      }
    `;
    const findings = scanFileForHardcodedUi('x.tsx', src);
    expect(findings).toEqual([]);
  });

  it('does not flag Tailwind className / URLs / technical ids', async () => {
    const { scanFileForHardcodedUi } = await loadScanner();
    const src = `
      export function Demo() {
        return (
          <a
            className="flex gap-2 px-4 hover:bg-amber-500 dark:text-slate-200"
            href="https://example.com/path"
            id="room_slot_12"
            data-testid="server-room"
          >
            USDC
          </a>
        );
      }
    `;
    const findings = scanFileForHardcodedUi('x.tsx', src);
    expect(findings).toEqual([]);
  });

  it('does not flag TypeScript generics as JSX text', async () => {
    const { scanFileForHardcodedUi } = await loadScanner();
    const src = `
      type Props = { onSave: () => void | Promise<void> };
      export function Demo(p: Props) {
        return <span>USDC</span>;
      }
    `;
    const findings = scanFileForHardcodedUi('x.tsx', src);
    expect(findings).toEqual([]);
  });

  it('flags alert/confirm hardcoded copy', async () => {
    const { scanFileForHardcodedUi } = await loadScanner();
    const src = `alert('Purchase failed somehow'); confirm('Really delete this rig?');`;
    const findings = scanFileForHardcodedUi('x.tsx', src);
    expect(findings.length).toBeGreaterThanOrEqual(2);
  });

  it('strict migrated files pass the scanner', async () => {
    const { scanStrictFiles } = await loadScanner();
    const findings = scanStrictFiles(process.cwd());
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });
});

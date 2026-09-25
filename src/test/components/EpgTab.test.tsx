import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import EpgTab from '../../components/settings/EpgTab';

const xtream = 'http://provider.example:8080/xmltv.php?username=mattias&password=s3cret';

function renderTab(epgUrl: string) {
  const onEpgUrlChange = vi.fn();
  render(
    <EpgTab
      epgUrl={epgUrl}
      onEpgUrlChange={onEpgUrlChange}
      epgStatus={null}
      isUpdatingEpg={false}
      onForceEpgUpdate={vi.fn()}
    />
  );
  return { onEpgUrlChange };
}

describe('EpgTab and provider credentials', () => {
  it('never shows the Xtream username or password in the URL field', () => {
    renderTab(xtream);
    const field = screen.getByLabelText('EPG URL (XMLTV format)');
    expect(field).toHaveValue('http://provider.example:8080/xmltv.php?username=••••&password=••••');
    expect(field).toHaveAttribute('readonly');
    expect(document.body.textContent).not.toContain('s3cret');
    expect(document.body.innerHTML).not.toContain('s3cret');
  });

  it('"Use a different URL" clears the field so a custom address can be typed', () => {
    const { onEpgUrlChange } = renderTab(xtream);
    fireEvent.click(screen.getByRole('button', { name: 'Use a different URL' }));
    expect(onEpgUrlChange).toHaveBeenCalledWith('');
  });

  it('shows a plain URL as an editable field without the button', () => {
    const { onEpgUrlChange } = renderTab('https://iptv-epg.org/se.xml.gz');
    const field = screen.getByLabelText('EPG URL (XMLTV format)');
    expect(field).toHaveValue('https://iptv-epg.org/se.xml.gz');
    expect(field).not.toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: 'Use a different URL' })).not.toBeInTheDocument();
    fireEvent.change(field, { target: { value: 'https://x.example/e.xml' } });
    expect(onEpgUrlChange).toHaveBeenCalledWith('https://x.example/e.xml');
  });
});

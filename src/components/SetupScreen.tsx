import { useState } from 'react';
import { LAYER_ORDER, MAX_DIM, MIN_DIM, type LayerId } from '../../shared/types.js';
import type { Transport } from '../api/client.js';
import LayerPicker from './LayerPicker.js';

const EXAMPLE =
  'The Sundered Coast: a long north-south continent on the western edge of a warm inland sea. ' +
  'A high mountain spine runs the length of the west coast and casts a deep rain shadow, so the ' +
  'interior east of the mountains is desert and cold steppe. The north is glaciated and broken ' +
  'into fjords; the south warms into monsoon jungle around a great river delta. A dense ' +
  'archipelago of trading islands sits in the middle of the inland sea.';

export default function SetupScreen({
  onCreate,
  onImport,
  transport,
  keyPresent,
  onOpenSettings,
}: {
  onCreate: (
    description: string,
    cols: number,
    rows: number,
    name: string,
    layers: LayerId[],
  ) => void;
  onImport: (file: File) => void;
  transport: Transport;
  /** Whether generation can actually run: a key is set, or the offline generator is on. */
  keyPresent: boolean;
  onOpenSettings: () => void;
}) {
  const [description, setDescription] = useState('');
  const [name, setName] = useState('Untitled map');
  const [cols, setCols] = useState('30');
  const [rows, setRows] = useState('22');
  const [layers, setLayers] = useState<LayerId[]>([...LAYER_ORDER]);

  const clamp = (v: string) =>
    Math.max(MIN_DIM, Math.min(MAX_DIM, Math.round(Number(v) || MIN_DIM)));

  return (
    <div className="setup">
      <h1>Fantasy hex map generator</h1>
      <p className="lede">
        Describe a world, choose a grid, and build it up one layer at a time - geography, elevation,
        climate, vegetation, rivers, cities, polities and population. Every layer is editable by hand
        or by instruction, and nothing regenerates behind your back.
      </p>

      <div className="stack">
        <div>
          <label>Map name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div>
          <label>Describe the geography</label>
          <textarea
            rows={9}
            placeholder="Rivers, ranges, seas, climate, peoples - anything you write here steers every layer."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <button className="tiny" style={{ marginTop: 6 }} onClick={() => setDescription(EXAMPLE)}>
            use an example description
          </button>
        </div>

        <div className="row">
          <div className="grow">
            <label>Columns (max {MAX_DIM})</label>
            <input
              type="number"
              min={MIN_DIM}
              max={MAX_DIM}
              value={cols}
              onChange={(e) => setCols(e.target.value)}
              onBlur={() => setCols(String(clamp(cols)))}
            />
          </div>
          <div className="grow">
            <label>Rows (max {MAX_DIM})</label>
            <input
              type="number"
              min={MIN_DIM}
              max={MAX_DIM}
              value={rows}
              onChange={(e) => setRows(e.target.value)}
              onBlur={() => setRows(String(clamp(rows)))}
            />
          </div>
          <div className="grow">
            <label>Total hexes</label>
            <div style={{ padding: '5px 0' }}>
              {(clamp(cols) * clamp(rows)).toLocaleString()}
            </div>
          </div>
        </div>

        <div>
          <label>Which layers should this map have?</label>
          <LayerPicker
            selection={layers}
            onChange={setLayers}
            cols={clamp(cols)}
            rows={clamp(rows)}
          />
          <p className="hint">
            You can add a layer you left out at any time, and remove one without losing its data.
          </p>
        </div>

        {transport.mode === 'server' && transport.health && !transport.health.credentials && !transport.health.mock && (
          <div className="notice error">
            The server has no Anthropic credentials. Copy <code>.env.example</code> to{' '}
            <code>.env</code> and set <code>ANTHROPIC_API_KEY</code>, or start it with{' '}
            <code>HEXMAP_MOCK=1</code> to use the offline procedural generator.
          </div>
        )}
        {transport.mode === 'server' && transport.health?.mock && (
          <div className="notice warn">
            The server is running its offline procedural generator, not Claude.
          </div>
        )}
        {transport.mode === 'browser' && !keyPresent && (
          <div className="notice warn">
            <b>No API key set.</b> This deployment has no server, so generation runs from your
            browser with a key you supply. It is stored in this browser only and is never part of
            the site anyone else downloads.
            <div style={{ marginTop: 6 }}>
              <button className="tiny" onClick={onOpenSettings}>
                open settings
              </button>
            </div>
          </div>
        )}
        {transport.mode === 'browser' && keyPresent && (
          <div className="notice info">
            Generating from your browser with your own key.{' '}
            <button className="tiny" onClick={onOpenSettings}>
              settings
            </button>
          </div>
        )}

        <div className="row">
          <button
            className="primary"
            disabled={description.trim().length === 0}
            onClick={() =>
              onCreate(description.trim(), clamp(cols), clamp(rows), name.trim() || 'Untitled map', layers)
            }
          >
            Create map
          </button>
          <label
            style={{
              textTransform: 'none',
              fontSize: 13,
              margin: 0,
              cursor: 'pointer',
              border: '1px solid var(--line)',
              borderRadius: 6,
              padding: '5px 10px',
            }}
          >
            Import a map JSON
            <input
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onImport(file);
              }}
            />
          </label>
        </div>
      </div>
    </div>
  );
}

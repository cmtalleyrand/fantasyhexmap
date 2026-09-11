import { useMemo, useState } from 'react';
import { LAYER_META } from '../../shared/layers.js';
import type { LayerId, MapState } from '../../shared/types.js';
import { contextFromMap, existingFeatures } from '../../core/context.js';
import { canSplit, passLabel, rosterFromContext, type PassId } from '../../core/passes.js';
import {
  buildWebchatPrompt,
  describePromptContext,
  importWebchatResponse,
  isPresent,
  webchatPromptTitle,
  WebchatImportError,
} from '../../core/webchat.js';
import {
  parseRoster,
  rosterToLines,
  RosterParseError,
  type Roster,
} from '../../core/rosters.js';
import type { DecodedLayer } from '../../core/decode.js';

export interface WebchatApplied extends DecodedLayer {
  roster: Roster | null;
  source: string;
}

interface Props {
  map: MapState;
  layer: LayerId;
  instruction: string | null;
  onApply: (result: WebchatApplied) => void;
  onClose: () => void;
}

type RosterSource = 'generated' | 'existing' | 'typed';

/**
 * Run a layer through a chat window instead of the API.
 *
 * The same prompt, carried by hand. This exists because the in-app path can
 * still be the wrong tool - no key configured, a layer that is expensive enough
 * to be worth a subscription rather than metered tokens, or simply wanting to
 * argue with the model about the borders before committing them.
 */
export default function WebchatDialog({ map, layer, instruction, onApply, onClose }: Props) {
  const splittable = canSplit(layer);
  const [pass, setPass] = useState<PassId>(splittable ? 'roster' : 'full');
  const [rosterSource, setRosterSource] = useState<RosterSource>('existing');
  const [rosterText, setRosterText] = useState('');
  const [reply, setReply] = useState('');
  const [source, setSource] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const ctx = useMemo(() => contextFromMap(map, instruction), [map, instruction]);
  const existingRoster = useMemo(() => rosterFromContext(layer, ctx), [layer, ctx]);

  /** The roster a paint pass will be drawn against, from whichever source. */
  const roster = useMemo((): Roster | null => {
    if (pass !== 'paint') return null;
    if (rosterSource === 'typed') {
      try {
        return parseRoster(layer as 'polities' | 'rivers', rosterText);
      } catch {
        return null;
      }
    }
    return existingRoster;
  }, [pass, rosterSource, rosterText, layer, existingRoster]);

  const rosterProblem = useMemo((): string | null => {
    if (pass !== 'paint') return null;
    if (rosterSource === 'typed') {
      if (!rosterText.trim()) return 'Type or paste a roster, one entry per line.';
      try {
        parseRoster(layer as 'polities' | 'rivers', rosterText);
        return null;
      } catch (e) {
        return e instanceof RosterParseError ? e.message : String(e);
      }
    }
    return existingRoster
      ? null
      : `This map has no ${LAYER_META[layer].label.toLowerCase()} yet, so there is no roster to reuse. Run the roster pass first, or type one in.`;
  }, [pass, rosterSource, rosterText, layer, existingRoster]);

  const prompt = useMemo(() => {
    if (rosterProblem) return null;
    try {
      return buildWebchatPrompt({ layer, pass, ctx, roster });
    } catch (e) {
      return `Could not build a prompt: ${e instanceof Error ? e.message : String(e)}`;
    }
  }, [layer, pass, ctx, roster, rosterProblem]);

  // The map is in the prompt, but it starts a few thousand characters down, past
  // the rules - so in a scrolling box it looks absent. This says what went in
  // without anyone having to read for it, and is built from the same context the
  // prompt is, so it cannot claim something the prompt does not carry.
  const contents = useMemo(() => describePromptContext(layer, pass, ctx), [layer, pass, ctx]);

  const copy = async () => {
    if (!prompt) return;
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setError('The browser would not give access to the clipboard. Select the prompt and copy it by hand.');
    }
  };

  const apply = () => {
    setError(null);
    try {
      const result = importWebchatResponse({
        layer,
        pass,
        ctx,
        text: reply,
        roster,
        existing: existingFeatures(ctx),
      });
      onApply({ ...result, source: source.trim() });
    } catch (e) {
      setError(
        e instanceof WebchatImportError ? e.message : e instanceof Error ? e.message : String(e),
      );
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide stack" onClick={(e) => e.stopPropagation()}>
        <h2>{webchatPromptTitle(layer, pass)} — by webchat</h2>
        <p className="hint">
          Copy the prompt into any chat window, then paste the JSON it replies with back here. It
          goes through the same checks and the same undo stack as a generation made from inside the
          app, and is recorded as imported so the decision log does not credit this app&rsquo;s model
          for it.
        </p>

        {splittable && (
          <div className="stack" style={{ gap: 4 }}>
            <label>Which pass</label>
            <select value={pass} onChange={(e) => setPass(e.target.value as PassId)}>
              <option value="roster">{passLabel(layer, 'roster')} — who and what exists</option>
              <option value="paint">{passLabel(layer, 'paint')} — against a fixed roster</option>
              <option value="full">{passLabel(layer, 'full')} — both at once</option>
            </select>
            <p className="hint" style={{ margin: 0 }}>
              Two smaller passes beat one large one on a big grid: deciding the cast and placing it
              constrain each other, and separating them is most of why this layer is expensive.
            </p>
          </div>
        )}

        {pass === 'paint' && (
          <div className="stack" style={{ gap: 4 }}>
            <label>Roster to draw against</label>
            <select
              value={rosterSource}
              onChange={(e) => {
                const next = e.target.value as RosterSource;
                setRosterSource(next);
                if (next === 'typed' && !rosterText && existingRoster) {
                  setRosterText(rosterToLines(existingRoster));
                }
              }}
            >
              <option value="existing">The one this map already has</option>
              <option value="typed">One I supply</option>
            </select>
            {rosterSource === 'typed' && (
              <textarea
                rows={5}
                value={rosterText}
                spellCheck={false}
                placeholder={
                  layer === 'polities'
                    ? 'One per line:\nThe Ardhic League | #b5533c\nBrennmark | #3f7a8c'
                    : 'One per line:\nKelder | rises on the Spine, runs south into the bay'
                }
                onChange={(e) => setRosterText(e.target.value)}
              />
            )}
          </div>
        )}

        {rosterProblem ? (
          <div className="notice warn">{rosterProblem}</div>
        ) : (
          <div className="stack" style={{ gap: 4 }}>
            <div className="row">
              <label style={{ flex: 1 }}>What this prompt carries</label>
              <span className="hint">
                {(prompt?.length ?? 0).toLocaleString()} characters
              </span>
            </div>
            <ul className="prompt-contents">
              {contents.map((entry) => (
                <li key={entry.label} className={isPresent(entry.status) ? 'in' : 'out'}>
                  <b>{entry.label}</b>
                  <span>{entry.detail}</span>
                </li>
              ))}
            </ul>

            <div className="row" style={{ marginTop: 4 }}>
              <label style={{ flex: 1 }}>The prompt itself</label>
              <button className="tiny" onClick={copy} disabled={!prompt}>
                {copied ? 'copied' : 'copy'}
              </button>
            </div>
            <textarea readOnly rows={14} value={prompt ?? ''} spellCheck={false} />
          </div>
        )}

        <div className="stack" style={{ gap: 4 }}>
          <label>The reply</label>
          <textarea
            rows={8}
            value={reply}
            spellCheck={false}
            placeholder="Paste the whole reply here. Surrounding prose and code fences are fine."
            onChange={(e) => setReply(e.target.value)}
          />
        </div>

        <div className="stack" style={{ gap: 4 }}>
          <label>What produced it (optional)</label>
          <input
            type="text"
            value={source}
            placeholder="e.g. Claude, via claude.ai"
            onChange={(e) => setSource(e.target.value)}
          />
          <p className="hint" style={{ margin: 0 }}>
            Recorded in the decision log so the record stays honest.
          </p>
        </div>

        {error && (
          <div className="notice error" style={{ whiteSpace: 'pre-wrap' }}>
            {error}
          </div>
        )}

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={apply} disabled={!reply.trim() || Boolean(rosterProblem)}>
            Import
          </button>
        </div>
      </div>
    </div>
  );
}

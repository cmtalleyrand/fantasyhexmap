import { useMemo, useState } from 'react';
import Modal from './Modal.js';
import { LAYER_META } from '../../shared/layers.js';
import { LAYER_ORDER, type LayerId, type MapState } from '../../shared/types.js';
import { contextFromMap, existingFeatures } from '../../core/context.js';
import { canSplit, passLabel, rosterFromContext, type PassId } from '../../core/passes.js';
import {
  buildMultiWebchatPrompt,
  buildWebchatPrompt,
  importMultiWebchatResponse,
  importWebchatResponse,
  multiLayerProblem,
  orderLayers,
  webchatPromptTitle,
  WebchatImportError,
  type MultiWebchatImportResult,
  type WebchatStyle,
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
  /** Layers ticked in the pipeline list; two or more open the dialog in several-layer mode. */
  initialLayers?: readonly LayerId[];
  onApply: (result: WebchatApplied) => void;
  /** Several layers from one reply, in pipeline order, applied together. */
  onApplyMany: (results: MultiWebchatImportResult[], source: string, instruction: string | null) => void;
  onClose: () => void;
}

type RosterSource = 'generated' | 'existing' | 'typed';
type Scope = 'one' | 'several';

/**
 * Run a layer through a chat window instead of the API.
 *
 * The same prompt, carried by hand. This exists because the in-app path can
 * still be the wrong tool - no key configured, a layer that is expensive enough
 * to be worth a subscription rather than metered tokens, or simply wanting to
 * argue with the model about the borders before committing them.
 */
export default function WebchatDialog({
  map,
  layer,
  instruction,
  initialLayers = [],
  onApply,
  onApplyMany,
  onClose,
}: Props) {
  const [ticked] = useState(() =>
    orderLayers(initialLayers.filter((id) => map.enabledLayers.includes(id))),
  );
  const [scope, setScope] = useState<Scope>(ticked.length > 1 ? 'several' : 'one');
  const [style, setStyle] = useState<WebchatStyle>('full');
  const [selected, setSelected] = useState<LayerId[]>(ticked.length > 1 ? ticked : [layer]);
  const splittable = canSplit(layer) && scope === 'one';
  const [pass, setPass] = useState<PassId>(splittable ? 'roster' : 'full');
  const [rosterSource, setRosterSource] = useState<RosterSource>('existing');
  const [rosterText, setRosterText] = useState('');
  const [reply, setReply] = useState('');
  const [source, setSource] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const ctx = useMemo(() => contextFromMap(map, instruction), [map, instruction]);
  const existingRoster = useMemo(() => rosterFromContext(layer, ctx), [layer, ctx]);
  const choosable = useMemo(
    () => LAYER_ORDER.filter((id) => map.enabledLayers.includes(id)),
    [map.enabledLayers],
  );
  const selectionProblem = useMemo(
    () => (scope === 'several' ? multiLayerProblem(selected, ctx) : null),
    [scope, selected, ctx],
  );
  const toggle = (id: LayerId) =>
    setSelected((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));

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
    if (scope === 'several' || pass !== 'paint') return null;
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

  const effectivePass: PassId = splittable ? pass : 'full';
  const problem = selectionProblem ?? rosterProblem;

  const prompt = useMemo(() => {
    if (problem) return null;
    try {
      return scope === 'several'
        ? buildMultiWebchatPrompt({ layers: selected, ctx, style })
        : buildWebchatPrompt({ layer, pass: effectivePass, ctx, roster, style });
    } catch (e) {
      return `Could not build a prompt: ${e instanceof Error ? e.message : String(e)}`;
    }
  }, [scope, selected, layer, effectivePass, ctx, roster, style, problem]);

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
      if (scope === 'several') {
        const results = importMultiWebchatResponse({
          layers: selected,
          ctx,
          text: reply,
          existing: existingFeatures(ctx),
        });
        onApplyMany(results, source.trim(), instruction);
        return;
      }
      const result = importWebchatResponse({
        layer,
        pass: effectivePass,
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
    <Modal label="Generate by webchat" className="wide stack" onClose={onClose}>
      <h2>
        {scope === 'several'
          ? `${orderLayers(selected).length} layers`
          : webchatPromptTitle(layer, effectivePass)}{' '}
        — by webchat
      </h2>
      <p className="hint">
        Copy the prompt into any chat window, then paste the JSON it replies with back here. It
        goes through the same checks and the same undo stack as a generation made from inside the
        app, and is recorded as imported so the decision log does not credit this app&rsquo;s model
        for it.
      </p>

      <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
        <div className="stack" style={{ gap: 4, flex: 1 }}>
          <label>Layers</label>
          <select value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
            <option value="one">{LAYER_META[layer].label} only</option>
            <option value="several">Several layers in one reply</option>
          </select>
        </div>
        <div className="stack" style={{ gap: 4, flex: 1 }}>
          <label>Reply style</label>
          <select value={style} onChange={(e) => setStyle(e.target.value as WebchatStyle)}>
            <option value="full">Everything in the JSON</option>
            <option value="compact">JSON for the data, decisions in the chat</option>
          </select>
        </div>
      </div>
      <p className="hint" style={{ margin: 0 }}>
        {style === 'compact'
          ? 'A shorter prompt: the model replies with the layer data as JSON and explains its plan and decisions in ordinary chat around it. That explanation is kept as the layer notes when you import the whole reply.'
          : 'The model replies with one JSON object that also carries its notes and decisions, which go into the decision log.'}
      </p>

      {scope === 'several' && (
        <div className="stack" style={{ gap: 4 }}>
          <label>Generate together</label>
          <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
            {choosable.map((id) => (
              <label
                key={id}
                className="row"
                style={{ gap: 6, margin: 0, cursor: 'pointer', textTransform: 'none', letterSpacing: 0, fontSize: 13 }}
              >
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={selected.includes(id)}
                  onChange={() => toggle(id)}
                />
                {LAYER_META[id].label}
              </label>
            ))}
          </div>
          <p className="hint" style={{ margin: 0 }}>
            One prompt, one reply. The layers are written in pipeline order, each built on the ones
            before it in the same reply, and imported together - or not at all if any of them is
            malformed. Each runs as a single pass.{' '}
            {instruction
              ? 'Your edit instruction is applied to every selected layer, each of which must already have data; they are rewritten from the state shown in the prompt.'
              : 'Selected layers that already exist are replaced.'}
          </p>
        </div>
      )}

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

      {splittable && pass === 'paint' && (
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

      {problem ? (
        <div className="notice warn">{problem}</div>
      ) : (
        <div className="stack" style={{ gap: 4 }}>
          <div className="row">
            <label style={{ flex: 1 }}>The prompt</label>
            <button className="tiny" onClick={copy} disabled={!prompt}>
              {copied ? 'copied' : 'copy'}
            </button>
          </div>
          <textarea readOnly rows={8} value={prompt ?? ''} spellCheck={false} />
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
        <button className="primary" onClick={apply} disabled={!reply.trim() || Boolean(problem)}>
          Import
        </button>
      </div>
    </Modal>
  );
}

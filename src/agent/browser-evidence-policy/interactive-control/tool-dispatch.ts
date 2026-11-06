// Whether one tool call against a browser-evidence context is authorized. Each
// tool the policy reads is admitted by its own check, keyed by the tool's name;
// a tool with no check and no standing withholding runs its normal path.
import type { WSession } from '../../../session/wsession.js';
import type { ControlDescriptor } from './descriptors.js';
import { controlDescriptors } from './descriptors.js';
import {
  ALWAYS_WITHHELD_TOOLS,
  SAFE_PAGE_KEYS,
  classify,
  matchingControl,
  readOnlyForm,
  safeClick,
  targetText,
} from './admission.js';
import { configuredTarget } from '../pinned-network.js';
import { loadSpecialAddresses } from '../../../proxy/quality/special-addresses.js';
import { enabled, recordEdge, safeText } from '../withheld-ledger.js';

export type BrowserEvidenceToolAuthorization = {
  invoke: () => Promise<string>;
};

type Decision = { category: string; reason: string };

/** What a check concluded: the call is withheld, or admitted with the exact invocation to run (null: its normal path). */
type Verdict =
  | { withheld: Decision; control: ControlDescriptor | null }
  | { admitted: BrowserEvidenceToolAuthorization | null };

interface ToolCall {
  session: WSession;
  args: Record<string, unknown>;
  text: string;
  pageUrl: string;
}

const NORMAL_PATH: Verdict = { admitted: null };

function withheld(
  category: string,
  reason: string,
  control: ControlDescriptor | null,
): Verdict {
  return { withheld: { category, reason }, control };
}

async function navigation({ args }: ToolCall): Promise<Verdict> {
  const requested =
    typeof args.url === 'string' && URL.canParse(args.url)
      ? new URL(args.url)
      : null;
  if (!requested)
    return withheld(
      'network_policy',
      'navigation URL is invalid or has no admitted target binding',
      null,
    );
  await loadSpecialAddresses();
  const target = configuredTarget();
  if (
    requested.protocol !== 'https:' ||
    requested.username ||
    requested.password ||
    requested.origin !== target.origin
  ) {
    return withheld(
      'network_policy',
      'navigation left the exact admitted public target origin',
      null,
    );
  }
  return NORMAL_PATH;
}

async function keyPress({ args }: ToolCall): Promise<Verdict> {
  const key = typeof args.key === 'string' ? args.key : null;
  if (key && Object.hasOwn(SAFE_PAGE_KEYS, key)) return NORMAL_PATH;
  // A key press that names no key, or Enter, can submit the active form.
  if (!key || key.toLowerCase() === 'enter') {
    return withheld(
      'form_submission',
      'Enter, or a key press that names no key, is withheld because it can submit the active form',
      null,
    );
  }
  return withheld(
    'system_ui_keyboard',
    'keyboard chord or system-capable key withheld',
    null,
  );
}

/** Whether the control is a search box: an input of type search, or an element with the searchbox role. */
function searchBox(control: ControlDescriptor): boolean {
  if (control.type === 'search') return true;
  return control.role === 'searchbox';
}

/** A tool that acts on one control: how the control is found, and what the call may do to it once it passed the withholding categories. */
interface ControlTool {
  /** The focused control (typing goes there), rather than the one the call names. */
  active: boolean;
  admit: (control: ControlDescriptor, call: ToolCall) => Verdict;
}

const clickTool: ControlTool = {
  active: false,
  admit: (control, { pageUrl }) => {
    if (!safeClick(control, pageUrl)) {
      return withheld(
        'ambiguous_interactive_control',
        'control is not an explicit same-origin link, tab, disclosure, or safe cancellation control',
        control,
      );
    }
    return {
      admitted: {
        invoke: async () => {
          await control.element.click();
          return `clicked exact browser-evidence control: ${safeText(control.label)}`;
        },
      },
    };
  },
};

/** A read-only GET search input updated with the call's value by `write`. */
function searchTool(
  active: boolean,
  write: (control: ControlDescriptor, value: string) => Promise<void>,
): ControlTool {
  return {
    active,
    admit: (control, { args, pageUrl }) => {
      const value = args.value;
      if (
        !searchBox(control) ||
        !readOnlyForm(control, pageUrl) ||
        typeof value !== 'string'
      ) {
        return withheld(
          'ambiguous_input_control',
          'only exact read-only GET search/filter inputs are permitted',
          control,
        );
      }
      return {
        admitted: {
          invoke: async () => {
            await write(control, value);
            return `updated exact read-only search control: ${safeText(control.label)}`;
          },
        },
      };
    },
  };
}

const CONTROL_TOOLS: Record<string, ControlTool> = {
  click: clickTool,
  js_click: clickTool,
  focus: {
    active: false,
    admit: (control) => ({
      admitted: {
        invoke: async () => {
          await control.element.focus();
          return `focused exact browser-evidence control: ${safeText(control.label)}`;
        },
      },
    }),
  },
  fill: searchTool(false, (control, value) => control.element.fill(value)),
  type_text: searchTool(true, (control, value) => control.element.type(value)),
  select_option: {
    active: false,
    // A select inside a read-only (GET) form only changes the query it reads.
    admit: (control, { args, pageUrl }) => {
      const value = args.value;
      if (
        control.tag !== 'select' ||
        !readOnlyForm(control, pageUrl) ||
        typeof value !== 'string'
      ) {
        return withheld(
          'ambiguous_input_control',
          'only exact read-only GET filter selections are permitted',
          control,
        );
      }
      return {
        admitted: {
          invoke: async () => {
            await control.element.selectOption(value);
            return `updated exact read-only filter control: ${safeText(control.label)}`;
          },
        },
      };
    },
  },
};

async function controlCall(
  tool: ControlTool,
  call: ToolCall,
): Promise<Verdict> {
  const descriptors = await controlDescriptors(call.session);
  const found = tool.active
    ? descriptors.find((candidate) => candidate.active)
    : matchingControl(call.text, descriptors);
  const control = found ? found : null;
  const declared = classify(call.text, control, call.pageUrl);
  if (declared) return { withheld: declared, control };
  if (!control)
    return withheld(
      'unresolved_interactive_control',
      'control did not resolve to one exact fresh element',
      null,
    );
  return tool.admit(control, call);
}

const TOOL_CHECKS: Record<string, (call: ToolCall) => Promise<Verdict>> = {
  navigate: navigation,
  press_key: keyPress,
  ...Object.fromEntries(
    Object.entries(CONTROL_TOOLS).map(([name, tool]) => [
      name,
      (call: ToolCall) => controlCall(tool, call),
    ]),
  ),
};

/**
 * The authorization of one tool call: null for the tool's normal path, an
 * exact invocation for a control the policy admitted, or a thrown
 * policy_withheld error after the withheld edge is in the ledger.
 */
export async function enforceBrowserEvidenceToolPolicy(
  session: WSession,
  tool: string,
  args: Record<string, unknown>,
): Promise<BrowserEvidenceToolAuthorization | null> {
  if (!enabled()) return null;
  const call: ToolCall = {
    session,
    args,
    text: targetText(tool, args),
    pageUrl: safeText(session.page.url()),
  };
  let verdict: Verdict = NORMAL_PATH;
  if (Object.hasOwn(ALWAYS_WITHHELD_TOOLS, tool))
    verdict = { withheld: ALWAYS_WITHHELD_TOOLS[tool], control: null };
  else if (Object.hasOwn(TOOL_CHECKS, tool))
    verdict = await TOOL_CHECKS[tool](call);
  if ('admitted' in verdict) return verdict.admitted;

  const { withheld: decision, control } = verdict;
  recordEdge(session.label, {
    category: decision.category,
    reason: decision.reason,
    source: 'tool_dispatch',
    tool,
    target: call.text,
    url: call.pageUrl,
    control: control
      ? {
          label: safeText(control.label),
          type: safeText(control.type),
          role: safeText(control.role),
          href: safeText(control.href),
          formAction: safeText(control.formAction),
        }
      : null,
  });
  throw new Error(`policy_withheld:${decision.category}:${decision.reason}`);
}

import { Node, Scope, SyntaxKind } from 'ts-morph';
import type { ClassDeclaration, Decorator } from 'ts-morph';
import type { Finding } from '../types.js';
import type { Capabilities } from '../version.js';

/**
 * Rules that read the class body.
 *
 * These are shared: a service is analyzed by the same functions, since
 * dependency counting and size measurement mean the same thing for both.
 */

export interface ClassRuleResult {
  injectedDeps: number;
  constructorDeps: number;
  inject: number;
  inputs: number;
  outputs: number;
  subscribeCalls: number;
  signalApiCalls: number | null;
  lifecycleHooks: number;
  publicMethods: number;
  classLoc: number;
  /**
   * Fields declared with signal()/computed()/input()/model() and friends.
   *
   * The template rules need this: `user()` in a template is a signal read and
   * costs nothing, while `getUser()` is a method call that re-runs on every
   * change detection cycle. They are indistinguishable in the template AST,
   * so the class has to say which names are signals.
   */
  signalFields: string[];
  findings: Finding[];
}

const LIFECYCLE_HOOKS = new Set([
  'ngOnInit',
  'ngOnChanges',
  'ngOnDestroy',
  'ngDoCheck',
  'ngAfterContentInit',
  'ngAfterContentChecked',
  'ngAfterViewInit',
  'ngAfterViewChecked',
]);

/** Functions that create signal-based state. */
const SIGNAL_FACTORIES = new Set(['signal', 'computed', 'effect', 'linkedSignal', 'toSignal']);

/** Functions that declare a signal-based input or output. */
const SIGNAL_IO = new Set(['input', 'output', 'model', 'viewChild', 'contentChild']);

/**
 * Subject types used for manual teardown, the pattern `takeUntilDestroyed()`
 * replaced. `BehaviorSubject` is deliberately not here: it is state, not
 * teardown, and has its own rule.
 */
const TEARDOWN_SUBJECTS = new Set(['Subject', 'ReplaySubject']);

export function analyzeClass(
  classDecl: ClassDeclaration,
  file: string,
  caps: Capabilities,
): ClassRuleResult {
  const findings: Finding[] = [];

  const constructorDeps = countConstructorDeps(classDecl, file, findings);
  const inject = countInjectCalls(classDecl);

  const io = countInputsOutputs(classDecl, file, findings, caps);
  const subscribeCalls = countSubscribeCalls(classDecl, file, findings);
  const signalApiCalls = caps.signals ? countSignalApiCalls(classDecl) : null;

  findRxjsStateFields(classDecl, file, findings);

  return {
    injectedDeps: constructorDeps + inject,
    constructorDeps,
    inject,
    inputs: io.inputs,
    outputs: io.outputs,
    subscribeCalls,
    signalApiCalls,
    lifecycleHooks: countLifecycleHooks(classDecl),
    publicMethods: countPublicMethods(classDecl),
    classLoc: measureClassLoc(classDecl),
    signalFields: collectSignalFields(classDecl),
    findings,
  };
}

/**
 * Constructor parameters that are actually injected.
 *
 * A constructor parameter with a default value and no decorator is a plain
 * argument, not a dependency, so it is excluded.
 */
function countConstructorDeps(
  classDecl: ClassDeclaration,
  file: string,
  findings: Finding[],
): number {
  const ctors = classDecl.getConstructors();
  let count = 0;

  for (const ctor of ctors) {
    for (const param of ctor.getParameters()) {
      const isDecorated = param.getDecorators().length > 0;
      const hasModifier = param.getScope() !== Scope.Public || param.isReadonly();
      const hasDefault = param.getInitializer() !== undefined;

      if (hasDefault && !isDecorated && !hasModifier) continue;
      count += 1;

      const pos = startPosition(param, file);
      findings.push({
        rule: 'constructor-di',
        ...pos,
        detail: param.getName(),
      });
    }
  }

  return count;
}

function countInjectCalls(classDecl: ClassDeclaration): number {
  return countCalls(classDecl, (name) => name === 'inject');
}

/**
 * Inputs and outputs, in both the decorator and the signal form.
 *
 * Accessors are walked as well as properties. `@Input() set value(v) {}` is a
 * property declaration to a reader but a SetAccessorDeclaration to the
 * compiler, and missing it understates exactly the old-style code this tool
 * exists to find. A decorated get/set pair counts once, by name.
 */
function countInputsOutputs(
  classDecl: ClassDeclaration,
  file: string,
  findings: Finding[],
  caps: Capabilities,
): { inputs: number; outputs: number } {
  const inputs = new Set<string>();
  const outputs = new Set<string>();

  const members = [
    ...classDecl.getProperties(),
    ...classDecl.getGetAccessors(),
    ...classDecl.getSetAccessors(),
  ];

  // Decorator form: @Input() / @Output()
  for (const member of members) {
    const name = member.getName();

    for (const decorator of member.getDecorators()) {
      const decoratorId = decoratorBaseName(decorator);

      if (decoratorId === 'Input' && !inputs.has(name)) {
        inputs.add(name);
        findings.push({ rule: 'decorator-input', ...startPosition(decorator, file), detail: name });
      } else if (decoratorId === 'Output' && !outputs.has(name)) {
        outputs.add(name);
        findings.push({ rule: 'decorator-output', ...startPosition(decorator, file), detail: name });
      }
    }
  }

  // Signal form: input() / input.required() / output() / model()
  if (caps.signalInputs) {
    for (const prop of classDecl.getProperties()) {
      const initializer = prop.getInitializer();
      if (!initializer) continue;

      const callName = signalIoCallName(initializer.getText());
      if (callName === 'input' || callName === 'model') inputs.add(prop.getName());
      else if (callName === 'output') outputs.add(prop.getName());
    }
  }

  return { inputs: inputs.size, outputs: outputs.size };
}

/** The decorator's bare name, so `@core.Input()` matches `@Input()`. */
function decoratorBaseName(decorator: Decorator): string {
  const full = decorator.getName();
  const dot = full.lastIndexOf('.');
  return dot === -1 ? full : full.slice(dot + 1);
}

/**
 * Match the leading identifier of a signal IO call, allowing the
 * `input.required<T>()` member form.
 */
function signalIoCallName(text: string): string | undefined {
  const match = /^([A-Za-z_$][\w$]*)/.exec(text);
  const head = match?.[1];
  if (!head || !SIGNAL_IO.has(head)) return undefined;
  return head;
}

function countSubscribeCalls(
  classDecl: ClassDeclaration,
  file: string,
  findings: Finding[],
): number {
  let count = 0;

  for (const call of classDecl.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expression = call.getExpression();
    if (!Node.isPropertyAccessExpression(expression)) continue;
    if (expression.getName() !== 'subscribe') continue;

    count += 1;
    findings.push({ rule: 'manual-subscribe', ...startPosition(call, file) });
  }

  return count;
}

/**
 * RxJS fields that a signal or `takeUntilDestroyed()` would replace.
 *
 * `behaviorsubject-state` fires on any `new BehaviorSubject()` field: that is
 * state held in a stream, and `signal()` is the modern form.
 *
 * `destroy-subject` needs two things together — a teardown Subject *and* an
 * `ngOnDestroy` — because a bare `Subject` field is a legitimate event stream.
 * It is the pairing that identifies the manual-teardown pattern. Whether the
 * subject is really the one completed in `ngOnDestroy` would need the method
 * body resolved; the pairing is accurate enough and stays single-file.
 */
function findRxjsStateFields(
  classDecl: ClassDeclaration,
  file: string,
  findings: Finding[],
): void {
  const hasNgOnDestroy = classDecl.getMethods().some((m) => m.getName() === 'ngOnDestroy');

  for (const prop of classDecl.getProperties()) {
    const initializer = prop.getInitializer();
    if (!initializer || !Node.isNewExpression(initializer)) continue;

    const constructed = baseName(initializer.getExpression().getText());

    if (constructed === 'BehaviorSubject') {
      findings.push({
        rule: 'behaviorsubject-state',
        ...startPosition(prop, file),
        detail: prop.getName(),
      });
    } else if (hasNgOnDestroy && TEARDOWN_SUBJECTS.has(constructed)) {
      findings.push({
        rule: 'destroy-subject',
        ...startPosition(prop, file),
        detail: prop.getName(),
      });
    }
  }
}

/** `rxjs.Subject` -> `Subject`. Strips any namespace qualifier. */
function baseName(text: string): string {
  const dot = text.lastIndexOf('.');
  return dot === -1 ? text : text.slice(dot + 1);
}

function countSignalApiCalls(classDecl: ClassDeclaration): number {
  return countCalls(classDecl, (name) => SIGNAL_FACTORIES.has(name));
}

/** Count call expressions whose callee identifier matches a predicate. */
function countCalls(classDecl: ClassDeclaration, matches: (name: string) => boolean): number {
  let count = 0;

  for (const call of classDecl.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expression = call.getExpression();
    if (!Node.isIdentifier(expression)) continue;
    if (matches(expression.getText())) count += 1;
  }

  return count;
}

/**
 * Names of fields initialised by a signal-producing factory.
 *
 * Matches on the leading identifier of the initialiser so member forms like
 * `input.required<T>()` and `viewChild.required()` are included.
 */
function collectSignalFields(classDecl: ClassDeclaration): string[] {
  const names: string[] = [];

  for (const prop of classDecl.getProperties()) {
    const initializer = prop.getInitializer();
    if (!initializer) continue;

    const match = /^([A-Za-z_$][\w$]*)/.exec(initializer.getText());
    const head = match?.[1];
    if (!head) continue;
    if (!SIGNAL_FACTORIES.has(head) && !SIGNAL_IO.has(head)) continue;

    names.push(prop.getName());
  }

  return names;
}

function countLifecycleHooks(classDecl: ClassDeclaration): number {
  return classDecl.getMethods().filter((m) => LIFECYCLE_HOOKS.has(m.getName())).length;
}

/**
 * Public methods, excluding lifecycle hooks.
 *
 * Hooks are public by necessity, not by design, so counting them would
 * overstate the class's real API surface.
 */
function countPublicMethods(classDecl: ClassDeclaration): number {
  return classDecl.getMethods().filter((m) => {
    if (LIFECYCLE_HOOKS.has(m.getName())) return false;
    return m.getScope() === Scope.Public;
  }).length;
}

/**
 * Lines in the class body, per RULES.md.
 *
 * Measured from the opening brace, not from the node start. A node starts at
 * its decorator, so measuring the declaration would fold the whole
 * `@Component({...})` block into the number — and for an inline template that
 * means counting the template twice, once here and once in `templateLoc`.
 */
function measureClassLoc(classDecl: ClassDeclaration): number {
  // Immediate children only. A descendant search would find the brace of the
  // decorator's object literal first, which is the bug this replaces.
  const [open] = classDecl.getChildrenOfKind(SyntaxKind.OpenBraceToken);
  const start = open ? open.getStartLineNumber() : classDecl.getStartLineNumber();
  return classDecl.getEndLineNumber() - start + 1;
}

/** Convert a node's start offset into a 1-based line/column finding position. */
function startPosition(node: Node, file: string): { file: string; line: number; col: number } {
  const sourceFile = node.getSourceFile();
  const start = node.getStart();
  return {
    file,
    line: sourceFile.getLineAndColumnAtPos(start).line,
    col: sourceFile.getLineAndColumnAtPos(start).column,
  };
}

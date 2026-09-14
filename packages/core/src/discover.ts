import { Node, SyntaxKind } from 'ts-morph';
import type { ClassDeclaration, Decorator, ObjectLiteralExpression, SourceFile } from 'ts-morph';
import type { ChangeDetectionFlag, StandaloneFlag, TemplateKind } from './types.js';

/**
 * Finding Angular entities in a source file.
 *
 * Everything here is deliberately single-file: nothing resolves an import or
 * opens a second file. That constraint is what keeps analysis parallelizable
 * and cacheable by mtime, which the MCP server depends on.
 */

export interface DiscoveredComponent {
  classDecl: ClassDeclaration;
  className: string;
  selector: string | undefined;
  changeDetectionFlag: ChangeDetectionFlag;
  standaloneFlag: StandaloneFlag;
  templateKind: TemplateKind;
  /** Raw value of templateUrl, unresolved. Resolution happens in step 4. */
  templateUrl: string | undefined;
  /** Inline template source, if `template:` was used. */
  inlineTemplate: string | undefined;
  /**
   * Line in the .ts file where the inline template literal begins.
   *
   * Without it, every finding inside an inline template reports line 1 of a
   * string the reader cannot navigate to.
   */
  inlineTemplateLine: number | undefined;
  /**
   * Where `@Component(` starts.
   *
   * Rules about what the decorator says — `standalone: false`, no OnPush —
   * are decided in analyze.ts, where the class metrics are also known. They
   * still need somewhere to point the developer.
   */
  decoratorPosition: { line: number; col: number };
}

/** Decorator names we recognise, mapped to the kind of entity they mark. */
const ENTITY_DECORATORS = new Set(['Component', 'Injectable', 'Directive', 'Pipe']);

/**
 * Find every class in the file carrying an @Component decorator.
 *
 * Classes with no decorator, or with a decorator we do not recognise, are
 * skipped silently. That is correct: a plain class is not an Angular entity.
 */
export function findComponents(sourceFile: SourceFile): DiscoveredComponent[] {
  const found: DiscoveredComponent[] = [];

  for (const classDecl of sourceFile.getClasses()) {
    const decorator = getEntityDecorator(classDecl, 'Component');
    if (!decorator) continue;

    const config = getDecoratorConfig(decorator);
    found.push({
      classDecl,
      className: classDecl.getName() ?? '(anonymous)',
      selector: readStringProperty(config, 'selector'),
      changeDetectionFlag: readChangeDetection(config),
      standaloneFlag: readStandalone(config),
      templateKind: readTemplateKind(config),
      templateUrl: readStringProperty(config, 'templateUrl'),
      inlineTemplate: readStringProperty(config, 'template'),
      inlineTemplateLine: readPropertyStartLine(config, 'template'),
      decoratorPosition: positionOf(decorator),
    });
  }

  return found;
}

/** True if this file contains any Angular entity at all. Cheap pre-filter. */
export function hasAngularEntity(sourceFile: SourceFile): boolean {
  return sourceFile
    .getClasses()
    .some((c) => c.getDecorators().some((d) => ENTITY_DECORATORS.has(decoratorName(d))));
}

function getEntityDecorator(classDecl: ClassDeclaration, name: string): Decorator | undefined {
  return classDecl.getDecorators().find((d) => decoratorName(d) === name);
}

/**
 * The decorator's bare name.
 *
 * Handles both `@Component({...})` and the namespaced `@core.Component({...})`
 * form, which appears in generated code.
 */
function decoratorName(decorator: Decorator): string {
  const full = decorator.getName();
  const dot = full.lastIndexOf('.');
  return dot === -1 ? full : full.slice(dot + 1);
}

/** The object literal passed to the decorator, if there is one. */
function getDecoratorConfig(decorator: Decorator): ObjectLiteralExpression | undefined {
  const [firstArg] = decorator.getArguments();
  if (!firstArg) return undefined;
  return Node.isObjectLiteralExpression(firstArg) ? firstArg : undefined;
}

/**
 * Read a property whose value is a string literal.
 *
 * Returns undefined for computed or variable values. That is deliberate: a
 * `selector: SELECTORS.foo` cannot be resolved without opening another file,
 * and guessing would be worse than reporting nothing.
 */
function readStringProperty(
  config: ObjectLiteralExpression | undefined,
  name: string,
): string | undefined {
  const initializer = getPropertyInitializer(config, name);
  if (!initializer) return undefined;

  if (Node.isStringLiteral(initializer) || Node.isNoSubstitutionTemplateLiteral(initializer)) {
    return initializer.getLiteralValue();
  }
  return undefined;
}

function getPropertyInitializer(config: ObjectLiteralExpression | undefined, name: string) {
  const prop = config?.getProperty(name);
  if (!prop || !Node.isPropertyAssignment(prop)) return undefined;
  return prop.getInitializer();
}

/**
 * Read `changeDetection` as a raw flag.
 *
 * The value arrives as a property access expression
 * (`ChangeDetectionStrategy.OnPush`), not a string, so we match on the
 * trailing identifier rather than a literal value.
 */
function readChangeDetection(config: ObjectLiteralExpression | undefined): ChangeDetectionFlag {
  const initializer = getPropertyInitializer(config, 'changeDetection');
  if (!initializer) return 'absent';

  const text = initializer.getText();
  if (text.endsWith('OnPush')) return 'OnPush';
  if (text.endsWith('Default')) return 'Default';
  return 'absent';
}

/**
 * Read `standalone` as a raw flag.
 *
 * "absent" must survive into the output untouched. From v19 standalone is the
 * default, so absence means standalone on modern projects and non-standalone
 * on older ones. Only the run's angularMajor can settle which, and that
 * decision belongs at read time, not here.
 */
function readStandalone(config: ObjectLiteralExpression | undefined): StandaloneFlag {
  const initializer = getPropertyInitializer(config, 'standalone');
  if (!initializer) return 'absent';

  const kind = initializer.getKind();
  if (kind === SyntaxKind.TrueKeyword) return 'true';
  if (kind === SyntaxKind.FalseKeyword) return 'false';
  return 'absent';
}

/**
 * Line the property's value starts on, so positions inside an inline template
 * can be translated back into the component file.
 */
function readPropertyStartLine(
  config: ObjectLiteralExpression | undefined,
  name: string,
): number | undefined {
  const initializer = getPropertyInitializer(config, name);
  return initializer?.getStartLineNumber();
}

/** 1-based line and column where a node starts. */
function positionOf(decorator: Decorator): { line: number; col: number } {
  const sourceFile = decorator.getSourceFile();
  const { line, column } = sourceFile.getLineAndColumnAtPos(decorator.getStart());
  return { line, col: column };
}

function readTemplateKind(config: ObjectLiteralExpression | undefined): TemplateKind {
  if (getPropertyInitializer(config, 'template')) return 'inline';
  if (getPropertyInitializer(config, 'templateUrl')) return 'external';
  return 'missing';
}

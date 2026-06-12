import { bold, dim, cyan, yellow, printJson } from './output.js';
import { flattenParams } from './schema.js';

const out = (s = '') => process.stdout.write(s + '\n');

export function rootHelp(registry, version) {
  const byResource = new Map();
  for (const cmd of registry.commands) {
    if (!byResource.has(cmd.resource)) byResource.set(cmd.resource, []);
    byResource.get(cmd.resource).push(cmd);
  }
  out(`${bold('tl')} — Teamleader Focus API command line client v${version} ${dim(`(API spec ${registry.specVersion})`)}

${bold('USAGE')}
  tl <resource> <action> [id] [--param value ...] [flags]
  tl <resource>                      list actions of a resource
  tl <resource> <action> --help      show all parameters of an action
  tl commands [--json]               machine-readable list of every command (for scripts/AI agents)
  tl auth <login|status|refresh|logout>

${bold('AUTHENTICATION')}
  tl auth login            guided OAuth2 setup (localhost callback, instructions included)
  tl auth login --manual   no local browser: paste the redirect URL into the terminal
  Environment overrides: TEAMLEADER_CLIENT_ID, TEAMLEADER_CLIENT_SECRET, TEAMLEADER_ACCESS_TOKEN

${bold('PARAMETERS')}
  API parameters map 1:1 to dot-path flags (see <action> --help for the full list):
    --filter.term "Pied Piper"            nested fields via dots
    --filter.tags expo --filter.tags vip  arrays: repeat the flag
    --sort.0.field name --sort.0.order desc   arrays of objects: numeric index
    --estimated_value '{"amount":100,"currency":"EUR"}'   any object/array as JSON
    --body '{...}' | --body @file.json | --body -          full request body (JSON / file / stdin)

${bold('GLOBAL FLAGS')}
  --json             raw JSON response (exact API output, best for scripting)
  --fields a,b.c     choose table columns (dot paths into the response)
  --limit N          shortcut for --page.size N
  --page N           shortcut for --page.number N
  --sort F[:asc|desc]  shortcut for --sort.0.field F [--sort.0.order]
  --include a,b      shortcut for --includes (sideload, e.g. custom_fields)
  --all              follow pagination and fetch every page
  --rm               REQUIRED to run destructive actions (safe mode is the default)
  --output FILE      save the file of a *.download action to disk
  --file FILE        upload a local file after files.upload returned its upload URL
  --dry-run          print the request that would be sent, without calling the API
  --verbose, -v      log requests to stderr
  --help, -h         help · --version

${bold('SAFE MODE')}
  Destructive actions (marked ${yellow('*')} below) never run unless --rm is given.

${bold('RESOURCES')} ${dim(`(${registry.commands.length} actions)`)}`);
  const width = Math.max(...[...byResource.keys()].map((r) => r.length));
  for (const [resource, cmds] of [...byResource.entries()].sort()) {
    const actions = cmds.map((c) => c.action + (c.destructive ? yellow('*') : '')).join(', ');
    out(`  ${cyan(resource.padEnd(width))}  ${actions}`);
  }
  out(`
${bold('EXAMPLES')}
  tl contacts list --filter.term "james" --limit 5
  tl companies info 5d2f4a0e-... --include custom_fields
  tl deals create --title "Big deal" --lead.customer.type company --lead.customer.id <uuid>
  tl invoices list --filter.status booked --sort invoice_date:desc --json
  tl invoices download <uuid> --format pdf --output invoice.pdf
  tl contacts delete <uuid> --rm`);
}

export function resourceHelp(registry, resource) {
  const cmds = registry.commands.filter((c) => c.resource === resource);
  const groupDesc = registry.groups[cmds[0].group];
  out(`${bold(`tl ${resource}`)} — ${cmds.length} action${cmds.length === 1 ? '' : 's'}`);
  if (groupDesc) out('\n' + dim(groupDesc.replace(/\*\*\*?|\*\*\*?/g, '')));
  out();
  const width = Math.max(...cmds.map((c) => c.action.length));
  for (const c of cmds) {
    const marks = (c.destructive ? yellow(' *destructive — requires --rm') : '') + (c.deprecated ? yellow(' (deprecated)') : '');
    out(`  ${cyan(c.action.padEnd(width))}  ${firstLine(c.description)}${marks}`);
  }
  out(`\nRun ${bold(`tl ${resource} <action> --help`)} for parameters.`);
}

function firstLine(s) {
  return (s || '').split('\n')[0];
}

export function actionHelp(cmd) {
  out(`${bold(`tl ${cmd.resource} ${cmd.action}`)} — ${cmd.path}`);
  if (cmd.deprecated) out(yellow('DEPRECATED'));
  if (cmd.description) out('\n' + cmd.description);
  if (cmd.destructive) out('\n' + yellow('Destructive action: only runs when --rm is given (safe mode).'));

  const rows = flattenParams(cmd.schema, '', cmd.schema?.required || []);
  const hasId = cmd.schema?.properties?.id;
  out(`\n${bold('USAGE')}`);
  out(`  tl ${cmd.resource} ${cmd.action}${hasId ? ' <id>' : ''}${rows.length ? ' [--param value ...]' : ''}${cmd.destructive ? ' --rm' : ''}`);

  if (rows.length) {
    out(`\n${bold('PARAMETERS')} ${dim('(dot-path flags; .N = array index; repeat flag to append to arrays)')}`);
    const width = Math.min(44, Math.max(...rows.map((r) => r.flag.length + 2)));
    for (const r of rows) {
      const flag = `--${r.flag}`;
      const req = r.required ? yellow(' (required)') : '';
      const dep = r.deprecated ? yellow(' (deprecated)') : '';
      let desc = firstLine(r.description);
      if (r.enum) {
        const list = r.enum.length > 12 ? r.enum.slice(0, 12).join('|') + '|…' : r.enum.join('|');
        desc += `${desc ? ' ' : ''}[${list}]`;
      }
      if (r.example !== undefined && !r.enum) desc += `${desc ? ' ' : ''}${dim(`e.g. ${JSON.stringify(r.example)}`)}`;
      out(`  ${cyan(flag.padEnd(width))} ${dim(r.type.padEnd(10))} ${req}${dep}${desc ? ' ' + desc : ''}`.trimEnd());
    }
  } else {
    out(`\n${dim('This action takes no parameters.')}`);
  }

  if (cmd.example) {
    out(`\n${bold('EXAMPLE REQUEST BODY')} ${dim('(equivalent to dot-path flags; pass with --body or individual flags)')}`);
    out(JSON.stringify(cmd.example, null, 2).split('\n').map((l) => '  ' + l).join('\n'));
  }
}

/** `tl commands` — complete command inventory, made for AI agents and scripts. */
export function listCommands(registry, { json }) {
  if (json) {
    printJson(
      registry.commands.map((c) => ({
        command: `tl ${c.resource} ${c.action}`,
        endpoint: c.path,
        description: c.description,
        destructive: c.destructive,
        deprecated: c.deprecated,
        parameters: flattenParams(c.schema, '', c.schema?.required || []).map((r) => ({
          flag: `--${r.flag}`,
          type: r.type,
          required: r.required || false,
          enum: r.enum,
          description: r.description || undefined,
          example: r.example,
        })),
      }))
    );
    return;
  }
  const width = Math.max(...registry.commands.map((c) => (c.resource + c.action).length + 1));
  for (const c of registry.commands) {
    const name = `${c.resource} ${c.action}`;
    out(`${cyan(name.padEnd(width))}  ${firstLine(c.description)}${c.destructive ? yellow(' *') : ''}${c.deprecated ? yellow(' (deprecated)') : ''}`);
  }
  out(dim(`\n${registry.commands.length} commands · * = destructive, requires --rm · details: tl <resource> <action> --help`));
}

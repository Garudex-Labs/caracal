// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal-cli completion <shell> [caracal|caracal-cli]`: emit shell completion bound to the canonical command catalog so suggestions never drift from the dispatchable surface.

import { CLI_COMMANDS, SHELL_COMMANDS, type CommandDescriptor } from '@caracalai/engine/commands'
import { printError } from '../style.ts'
import { availableInterfaceCommands } from './dispatch.ts'

type Shell = 'bash' | 'zsh' | 'fish' | 'powershell'
type Target = 'caracal' | 'caracal-cli'
const SHELLS: readonly Shell[] = ['bash', 'zsh', 'fish', 'powershell']
const TARGETS: readonly Target[] = ['caracal', 'caracal-cli']
function shellCommandTable(): readonly CommandDescriptor[] {
  const available = new Set(['up', 'down', 'status', 'purge', ...availableInterfaceCommands()])
  return SHELL_COMMANDS.filter((command) => available.has(command.name))
}

function tableFor(bin: Target): readonly CommandDescriptor[] {
  if (bin === 'caracal') return shellCommandTable()
  return CLI_COMMANDS
}

function topAndSubs(table: readonly CommandDescriptor[]) {
  const top: string[] = []
  const subs: Record<string, readonly string[]> = {}
  for (const c of table) {
    top.push(c.name)
    if (c.subcommands && c.subcommands.length > 0) subs[c.name] = c.subcommands
  }
  return { top, subs }
}

function fnName(bin: Target): string {
  return `_${bin.replace(/-/g, '_')}`
}

function bashScript(bin: Target, top: readonly string[], subs: Record<string, readonly string[]>): string {
  const cases = Object.entries(subs)
    .map(([n, list]) => `    ${n}) COMPREPLY=( $(compgen -W "${list.join(' ')}" -- "$cur") ); return 0 ;;`)
    .join('\n')
  return `# ${bin} bash completion
${fnName(bin)}() {
  local cur prev words cword
  _init_completion -n : || return
  if [ "$cword" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${top.join(' ')}" -- "$cur") )
    return 0
  fi
  case "\${words[1]}" in
${cases}
  esac
}
complete -F ${fnName(bin)} ${bin}
`
}

function zshScript(bin: Target, top: readonly string[], subs: Record<string, readonly string[]>): string {
  const blocks = Object.entries(subs)
    .map(([n, list]) => `    ${n}) _values 'subcommand' ${list.map((s) => `'${s}'`).join(' ')} ;;`)
    .join('\n')
  return `#compdef ${bin}
${fnName(bin)}() {
  local -a cmds
  cmds=(${top.map((c) => `'${c}'`).join(' ')})
  if (( CURRENT == 2 )); then
    _describe 'command' cmds
    return
  fi
  case "\${words[2]}" in
${blocks}
  esac
}
${fnName(bin)} "$@"
`
}

function fishScript(bin: Target, top: readonly string[], subs: Record<string, readonly string[]>): string {
  const lines: string[] = [`complete -c ${bin} -f`]
  lines.push(`complete -c ${bin} -n '__fish_use_subcommand' -a '${top.join(' ')}'`)
  for (const [n, list] of Object.entries(subs)) {
    lines.push(`complete -c ${bin} -n '__fish_seen_subcommand_from ${n}' -a '${list.join(' ')}'`)
  }
  return lines.join('\n') + '\n'
}

function powershellScript(bin: Target, top: readonly string[], subs: Record<string, readonly string[]>): string {
  const subEntries = Object.entries(subs)
    .map(([n, list]) => `    '${n}' = @(${list.map((s) => `'${s}'`).join(', ')})`)
    .join('\n')
  return `# ${bin} PowerShell completion
Register-ArgumentCompleter -Native -CommandName ${bin} -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $top = @(${top.map((c) => `'${c}'`).join(', ')})
  $subs = @{
${subEntries}
  }
  $tokens = $commandAst.CommandElements | ForEach-Object { $_.ToString() }
  if ($tokens.Count -le 2) {
    $top | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
    return
  }
  $cmd = $tokens[1]
  if ($subs.ContainsKey($cmd)) {
    $subs[$cmd] | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
  }
}
`
}

function emit(bin: Target, shell: Shell): string {
  const { top, subs } = topAndSubs(tableFor(bin))
  switch (shell) {
    case 'bash': return bashScript(bin, top, subs)
    case 'zsh': return zshScript(bin, top, subs)
    case 'fish': return fishScript(bin, top, subs)
    case 'powershell': return powershellScript(bin, top, subs)
  }
}

export function completionCommand(argv: string[]): void {
  const shell = argv[0] as Shell | undefined
  const targetArg = argv[1] as Target | 'both' | undefined
  if (!shell || !SHELLS.includes(shell)) {
    printError(`usage: caracal-cli completion <${SHELLS.join('|')}> [${TARGETS.join('|')}|both]`)
    process.exit(1)
  }
  const target = targetArg ?? 'both'
  if (target !== 'both' && !TARGETS.includes(target as Target)) {
    printError(`completion target must be one of: ${TARGETS.join(', ')}, both`)
    process.exit(1)
  }
  const bins: readonly Target[] = target === 'both' ? TARGETS : [target as Target]
  process.stdout.write(bins.map((b) => emit(b, shell)).join('\n'))
}

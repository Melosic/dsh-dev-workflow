import { describe, expect, it } from 'vitest'
import {
  programInvocations,
  programWords,
  quoteCommandWords,
  segments,
  shellArgument,
  shellWordIsLiteral,
  skipWrappers,
  subcommandWords,
  tokenize,
  wordInvocations,
} from '../src/shell.js'

// The lexer every guard and trigger reads a command line with. Until this spec
// existed, each behaviour was only exercised through the five callers that
// happened to describe it, which is how a command line could be read one way by
// the git guard and a different way by the file guard.
//
// The cases are written as the shapes a shell really accepts, including the ones
// that used to read as a *different* command: a nested `sh -c`, a substitution
// spliced into the token stream, and a Windows path whose separators are not
// escapes.

describe('tokenize', () => {
  it('splits words, keeps operators as their own tokens', () => {
    expect(tokenize('git commit -m "a b" && npm test')).toEqual([
      'git',
      'commit',
      '-m',
      'a b',
      '&&',
      'npm',
      'test',
    ])
  })

  it('resolves quotes and escapes', () => {
    expect(tokenize(`echo 'one two' three\\ four`)).toEqual(['echo', 'one two', 'three four'])
  })

  it('keeps a backslash that escapes nothing, so a Windows path survives', () => {
    // `\U` is not an escape in any shell; treating it as one turned the path
    // into `C:Usersx.env`, and every path rule downstream then missed it.
    expect(tokenize('type C:\\Users\\x\\.env')).toEqual(['type', 'C:\\Users\\x\\.env'])
    expect(tokenize('cat "C:\\Users\\x\\.env"')).toEqual(['cat', 'C:\\Users\\x\\.env'])
  })

  it('splices a command substitution in as its own command', () => {
    // The boundary on both sides is what makes the inner words a command of
    // their own. With only the closing one, `cat $(rm -rf /)` read as one
    // command whose program was `cat` and whose arguments looked harmless.
    expect(tokenize('echo $(git push --force)')).toEqual([
      'echo',
      ';',
      'git',
      'push',
      '--force',
      ';',
    ])
  })

  it('keeps ${name} whole, because it is one word to the shell', () => {
    expect(tokenize('echo ${HOME}/*')).toEqual(['echo', '${HOME}/*'])
  })

  it('reads a nested substitution', () => {
    expect(tokenize('echo $(echo $(id))')).toEqual(['echo', ';', 'echo', ';', 'id', ';', ';'])
  })

  it('splits on a lone ampersand, which backgrounds a whole command', () => {
    // `cmd & rm -rf /` runs both. With `&` missing from the operator set the
    // line read as one command whose program was `cmd`, so the second half was
    // never a candidate for any of the guards.
    expect(tokenize('cmd & rm -rf /')).toEqual(['cmd', '&', 'rm', '-rf', '/'])
    expect(tokenize('cmd&rm -rf /')).toEqual(['cmd', '&', 'rm', '-rf', '/'])
  })

  it('ends a word at a redirection, whether or not a space is there', () => {
    // `cat<.env` used to stay one word that matched no program name, which made
    // "no spaces around the operator" a way to read any file unwatched.
    expect(tokenize('cat<.env')).toEqual(['cat', '.env'])
    expect(tokenize('cat < .env')).toEqual(['cat', '.env'])
    expect(tokenize('cmd &> log')).toEqual(['cmd'])
  })

  it('reads the digit before a redirect as its descriptor, not a word', () => {
    // Flushing the `2` made it the program, and the command behind the redirect
    // — here a read of `.env` — was never seen.
    expect(tokenize('cmd 2>&1 cat .env')).toEqual(['cmd', 'cat', '.env'])
    expect(tokenize('cmd 2>/dev/null')).toEqual(['cmd'])
  })

  it('keeps the file a read redirect opens and drops the one a write redirect writes', () => {
    // The two are not the same thing to the guards: `cat < .env` reads a
    // sensitive file and must stay visible, while `2>/dev/null git push` names
    // no file anyone opens — keeping `/dev/null` split the program list at the
    // slash and left `null` as the command that ran.
    expect(tokenize('cat < .env')).toEqual(['cat', '.env'])
    expect(tokenize('2>/dev/null git push --force')).toEqual(['git', 'push', '--force'])
    expect(tokenize('git push --force > /tmp/log')).toEqual(['git', 'push', '--force'])
  })
})

describe('segments', () => {
  it('cuts on every operator the shell chains commands with', () => {
    expect(segments(tokenize('a && b || c ; d | e'))).toEqual([['a'], ['b'], ['c'], ['d'], ['e']])
  })
})

describe('skipWrappers', () => {
  it('peels stacked wrappers, not just the first', () => {
    expect(programWords(['nohup', 'doas', 'git', 'push'])).toEqual(['git', 'push'])
  })

  it('steps over an option that takes a value', () => {
    expect(programWords(['sudo', '-u', 'root', 'git', 'push'])).toEqual(['git', 'push'])
    expect(programWords(['sudo', '--user=root', 'rm', '-rf', '/'])).toEqual(['rm', '-rf', '/'])
  })

  it('steps over assignments', () => {
    expect(programWords(['env', 'FOO=1', 'git', 'status'])).toEqual(['git', 'status'])
  })

  it('leaves an unwrapped command alone', () => {
    expect(skipWrappers(['git', 'status'])).toBe(0)
  })

  it('steps over a resource-limit wrapper to the command it runs', () => {
    // `timeout 120 git push --force` is an ordinary way to write a push with a
    // deadline. The wrapper used to be read as the program, so every guard saw
    // `timeout` and judged nothing behind it.
    expect(programWords(['timeout', '120', 'git', 'push'])).toEqual(['git', 'push'])
    expect(programWords(['timeout', '30s', 'git', 'push'])).toEqual(['git', 'push'])
    expect(programWords(['nice', '-n', '10', 'git', 'push'])).toEqual(['git', 'push'])
    expect(programWords(['stdbuf', '-oL', 'git', 'push'])).toEqual(['git', 'push'])
    expect(programWords(['ionice', '-c3', 'git', 'push'])).toEqual(['git', 'push'])
    expect(programWords(['watch', 'git', 'push'])).toEqual(['git', 'push'])
  })

  it('steps over every option a wrapper takes, not only the first', () => {
    expect(programWords(['sudo', '-n', '-u', 'root', 'rm', '-rf', '/'])).toEqual(['rm', '-rf', '/'])
    expect(programWords(['timeout', '-s', 'KILL', '120', 'git', 'push'])).toEqual(['git', 'push'])
  })

  it('reads a wrapper option value from that wrapper, not from a shared table', () => {
    // `sudo -p` takes a value, `time -p` does not. One global set of value
    // options skipped the program after `time -p` and left `sudo -p` reading its
    // prompt text as the program.
    expect(programWords(['time', '-p', 'git', 'push'])).toEqual(['git', 'push'])
    expect(programWords(['sudo', '-p', 'Password:', 'git', 'push'])).toEqual(['git', 'push'])
  })

  it('leaves the command after a boolean wrapper flag in place', () => {
    expect(programWords(['env', '-i', 'git', 'push'])).toEqual(['git', 'push'])
  })
})

describe('shellArgument', () => {
  it('reads the script a shell was asked to run', () => {
    expect(shellArgument(['sh', '-c', 'rm -rf /'])).toBe('rm -rf /')
    expect(shellArgument(['bash', '-c', 'git push'])).toBe('git push')
  })

  it('reads it out of a clustered flag too', () => {
    // `bash -lc` and `sh -ec` are how a script is run in CI; only the bare `-c`
    // used to be recognised, so the command string went unread and every check
    // behind it saw a shell that runs nothing.
    expect(shellArgument(['bash', '-lc', 'rm -rf /'])).toBe('rm -rf /')
    expect(shellArgument(['sh', '-ec', 'git push --force'])).toBe('git push --force')
  })

  it('is undefined for a program that runs no script', () => {
    expect(shellArgument(['git', 'push'])).toBeUndefined()
  })

  it('reads a script only from a program that runs one', () => {
    // `-c` is a script for a shell and a config flag for anything else. Reading
    // the flag of *any* program as a command string meant
    // `git -c core.pager=cat log` was judged as the command `core.pager=cat log`,
    // and the real one was never looked at.
    expect(shellArgument(['git', '-c', 'core.pager=cat', 'log'])).toBeUndefined()
    expect(shellArgument(['-c', 'rm -rf /'])).toBeUndefined()
  })
})

describe('programInvocations', () => {
  it('reports the program inside a shell it delegates to', () => {
    expect(programInvocations('sh -c "git push --force origin main"')).toEqual([
      { program: 'git', args: ['push', '--force', 'origin', 'main'] },
    ])
  })

  it('reports the program inside a shell started with a clustered flag', () => {
    expect(programInvocations(`bash -lc 'git push --force origin main'`)).toEqual([
      { program: 'git', args: ['push', '--force', 'origin', 'main'] },
    ])
  })

  it('reports the program inside a substitution, whoever it is an argument to', () => {
    // The absorbing case: `cat $(rm -rf /)` ran a delete, and reading it as one
    // command whose program is `cat` made every guard miss it.
    expect(programInvocations('cat $(rm -rf /)')).toEqual([
      { program: 'cat', args: [] },
      { program: 'rm', args: ['-rf', '/'] },
    ])
  })

  it('reports one invocation per chained command', () => {
    expect(programInvocations('git tag v1 && npm publish')).toEqual([
      { program: 'git', args: ['tag', 'v1'] },
      { program: 'npm', args: ['publish'] },
    ])
  })

  it('reads through a wrapper', () => {
    expect(programInvocations('sudo -u root git push --force')).toEqual([
      { program: 'git', args: ['push', '--force'] },
    ])
  })

  it('reports the command a leading redirect used to hide', () => {
    // `2>/dev/null git push --force` is how a force push is written when the
    // output should stay quiet. It read as a command named `null`, so the git
    // guard saw nothing at all.
    expect(programInvocations('2>/dev/null git push --force')).toEqual([
      { program: 'git', args: ['push', '--force'] },
    ])
  })

  it('reports the program a command runner was pointed at', () => {
    // `npx -c` takes the command as its value. Reading `-c` as a plain wrapper
    // option skipped the program after it, and the guard saw no program at all.
    expect(programInvocations(`npx -c 'rm -rf /'`)).toEqual([{ program: 'rm', args: ['-rf', '/'] }])
    expect(programInvocations('npx -y eslint .')).toEqual([{ program: 'eslint', args: ['.'] }])
  })
})

describe('quoteCommandWords', () => {
  it('marks a single-quoted word literal, even when it looks like a substitution', () => {
    const [word] = quoteCommandWords("'$(cat x)'")
    expect(word?.value).toBe('$(cat x)')
    expect(word === undefined ? false : shellWordIsLiteral(word)).toBe(true)
  })

  it('marks a double-quoted word with a substitution as not literal', () => {
    const words = quoteCommandWords('"$(cat x)"')
    expect(words.every((word) => !shellWordIsLiteral(word))).toBe(true)
  })

  it('reads a redirect target out of the word stream like the tokens do', () => {
    // One command line, two answers, was the bug: the guards read this through
    // `tokenize` and the commit checks through `quoteCommandWords`.
    expect(quoteCommandWords('2>/dev/null git push --force').map((word) => word.value)).toEqual([
      'git',
      'push',
      '--force',
    ])
    expect(quoteCommandWords('cat < .env').map((word) => word.value)).toEqual(['cat', '.env'])
  })

  it('treats a bare variable as not literal', () => {
    const words = quoteCommandWords('git commit -m $msg')
    const message = words[3]
    expect(message?.value).toBe('$msg')
    expect(message === undefined ? true : shellWordIsLiteral(message)).toBe(false)
  })

  it('keeps prose that merely contains a backtick literal in single quotes', () => {
    const [word] = quoteCommandWords("'Run `/dev-workflow status`'")
    expect(word === undefined ? false : shellWordIsLiteral(word)).toBe(true)
  })

  it('keeps both halves of a name whose tail is a substitution', () => {
    // `git tag v$(cat VERSION)` names one tag: `v` is readable, the rest is not.
    // Reporting the fragment as the whole name would judge a tag that does not
    // exist, and dropping the substitution's words into the argument list would
    // invent two more.
    const words = quoteCommandWords('git tag v$(cat VERSION)')
    const tag = words[2]
    expect(tag?.value).toBe('v$(cat VERSION)')
    expect(tag === undefined ? true : shellWordIsLiteral(tag)).toBe(false)
    expect(words.map((word) => word.value)).toEqual([
      'git',
      'tag',
      'v$(cat VERSION)',
      ';',
      'cat',
      'VERSION',
      ';',
    ])
  })
})

describe('wordInvocations', () => {
  it('carries the quoting of each argument alongside it', () => {
    const found = wordInvocations(quoteCommandWords(`git commit -m "Add the thing"`))
    const word = found[0]?.args[2]
    expect(word?.value).toBe('Add the thing')
    expect(word === undefined ? false : shellWordIsLiteral(word)).toBe(true)
  })
})

describe('subcommandWords', () => {
  it('finds the subcommand after git\u2019s own value options', () => {
    const words = quoteCommandWords('git -C /repo commit -m x')
    const found = subcommandWords(words.slice(1))
    expect(found?.subcommand).toBe('commit')
  })
})

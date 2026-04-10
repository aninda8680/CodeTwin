import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';

type LogEntry = {
    type: 'user' | 'observation' | 'thought' | 'action' | 'result' | 'plan';
    text: string;
};

const planSteps = [
    '1. Parse the user request and identify intent',
    '2. Search workspace for relevant files',
    '3. Read file contents and understand context',
    '4. Generate code changes',
    '5. Write changes and verify correctness',
];

const thoughtStream = [
    'Decomposing task into atomic operations...',
    'Identifying relevant source files...',
    'Mapping dependency graph...',
    'Evaluating modification strategy...',
    'Checking for breaking changes...',
];

const actionStream = [
    'grep_search({ query: "export default", path: "src/" })',
    'read_file("src/index.tsx")',
    'list_dir("src/components/")',
    'write_file("src/utils/helper.ts", ...)',
    'run_command("npx tsc --noEmit")',
];

export const AgentCanvas = () => {
    const [query, setQuery] = useState('');
    const [phase, setPhase] = useState<'idle' | 'planning' | 'thinking' | 'acting' | 'done'>('idle');
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [step, setStep] = useState(0);
    const [taskCount, setTaskCount] = useState(0);

    useEffect(() => {
        if (phase === 'idle' || phase === 'done') return;
        let timer: ReturnType<typeof setTimeout>;

        if (phase === 'planning') {
            timer = setTimeout(() => {
                // Show all plan steps at once
                const plans: LogEntry[] = planSteps.map(s => ({ type: 'plan', text: s }));
                setLogs(prev => [...prev.slice(-15), ...plans]);
                setStep(0);
                setPhase('thinking');
            }, 600);
        } else if (phase === 'thinking') {
            timer = setTimeout(() => {
                const msg = thoughtStream[step % thoughtStream.length];
                setLogs(prev => [...prev.slice(-15), { type: 'thought', text: msg }]);
                if (step >= 2) {
                    setStep(0);
                    setPhase('acting');
                } else {
                    setStep(s => s + 1);
                }
            }, 700 + Math.random() * 300);
        } else if (phase === 'acting') {
            timer = setTimeout(() => {
                const tool = actionStream[step % actionStream.length];
                setLogs(prev => [...prev.slice(-15), { type: 'action', text: tool }]);
                if (step >= 2) {
                    setTimeout(() => {
                        setLogs(prev => [
                            ...prev.slice(-15),
                            { type: 'observation', text: 'All checks passing. No errors found.' },
                            { type: 'result', text: 'Task completed successfully.' },
                        ]);
                        setTaskCount(c => c + 1);
                        setPhase('done');
                    }, 800);
                } else {
                    setStep(s => s + 1);
                }
            }, 900 + Math.random() * 400);
        }

        return () => clearTimeout(timer);
    }, [phase, step]);

    const prefixMap: Record<LogEntry['type'], { icon: string; color: string }> = {
        user:        { icon: '  ❯ ', color: '#00FFFF' },
        plan:        { icon: '  ◇ ', color: '#2E8B8B' },
        observation: { icon: '  ◎ ', color: '#20B2AA' },
        thought:     { icon: '  ◆ ', color: '#20B2AA' },
        action:      { icon: '  ▶ ', color: '#00FF7F' },
        result:      { icon: '  ✔ ', color: '#00FF7F' },
    };

    return (
        <Box flexDirection="column" flexGrow={1}>
            {/* Top task bar */}
            <Box borderStyle="round" borderColor="#2E8B8B" paddingX={1} marginBottom={1} justifyContent="space-between">
                <Box>
                    <Text color="#00FFFF" bold>◈ AGENT LOOP</Text>
                    <Text color="gray">  │  </Text>
                    <Text color={phase === 'idle' ? 'gray' : (phase === 'done' ? '#00FF7F' : '#00FFFF')}>
                        {phase === 'idle' ? 'standby' : phase === 'done' ? 'completed' : phase}
                    </Text>
                </Box>
                <Box>
                    <Text color="gray">tasks: </Text>
                    <Text color="#00FFFF">{taskCount}</Text>
                </Box>
            </Box>

            {/* Reasoning trace */}
            <Box flexDirection="column" borderStyle="round" borderColor="#2E8B8B" padding={1} flexGrow={1}>
                {logs.length === 0 && phase === 'idle' && (
                    <Box flexDirection="column">
                        <Text color="gray" dimColor>  No active traces. Submit a task below to begin.</Text>
                        <Box marginTop={1}/>
                        <Text color="#2E8B8B" dimColor>  hint: try "refactor the auth module" or "add unit tests"</Text>
                    </Box>
                )}

                {logs.map((log, i) => {
                    const pf = prefixMap[log.type];
                    return (
                        <Box key={i}>
                            <Text color={pf.color} bold>{pf.icon}</Text>
                            <Text
                                color={log.type === 'plan' ? '#2E8B8B' : (log.type === 'thought' ? 'gray' : 'white')}
                                dimColor={log.type === 'plan'}
                                wrap="truncate-end"
                            >
                                {log.text}
                            </Text>
                        </Box>
                    );
                })}

                {phase === 'planning' && (
                    <Box marginTop={1}>
                        <Text color="#2E8B8B">  <Spinner type="dots" /> constructing execution plan...</Text>
                    </Box>
                )}
                {phase === 'thinking' && (
                    <Box marginTop={1}>
                        <Text color="#20B2AA">  <Spinner type="dots" /> reasoning...</Text>
                    </Box>
                )}
                {phase === 'acting' && (
                    <Box marginTop={1}>
                        <Text color="#00FF7F">  <Spinner type="dots" /> executing tools...</Text>
                    </Box>
                )}
            </Box>

            {/* Prompt */}
            <Box
                borderStyle="round"
                borderColor={phase === 'idle' || phase === 'done' ? '#00FFFF' : '#2E8B8B'}
                paddingX={1}
                marginTop={1}
            >
                <Box marginRight={1}>
                    <Text color="#00FFFF" bold>❯</Text>
                </Box>
                <TextInput
                    value={query}
                    onChange={setQuery}
                    onSubmit={() => {
                        if (query.toLowerCase() === 'exit') process.exit(0);
                        if (query.trim() === '') return;
                        setLogs(prev => [...prev.slice(-15), { type: 'user', text: query }]);
                        setQuery('');
                        setStep(0);
                        setPhase('planning');
                    }}
                    placeholder="describe your task..."
                />
            </Box>
        </Box>
    );
};

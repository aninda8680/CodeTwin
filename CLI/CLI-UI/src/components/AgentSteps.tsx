import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';

export const AgentSteps = () => {
    const [activeStep, setActiveStep] = useState(0);

    useEffect(() => {
        const t = setInterval(() => setActiveStep(s => (s + 1) % 5), 3000);
        return () => clearInterval(t);
    }, []);

    const steps = [
        { label: 'Parse',    desc: 'Understanding intent' },
        { label: 'Search',   desc: 'Finding relevant code' },
        { label: 'Analyze',  desc: 'Reading context' },
        { label: 'Generate', desc: 'Writing changes' },
        { label: 'Verify',   desc: 'Running checks' },
    ];

    return (
        <Box flexDirection="column" width={26} borderStyle="round" borderColor="#2E8B8B" padding={1} marginLeft={1}>
            <Text color="#00FFFF" bold>◈ PIPELINE</Text>

            <Box marginTop={1} flexDirection="column">
                {steps.map((step, i) => {
                    const isActive = i === activeStep;
                    const isDone = i < activeStep;
                    return (
                        <Box key={i} marginBottom={1} flexDirection="column">
                            <Box>
                                <Text color={isDone ? '#00FF7F' : (isActive ? '#00FFFF' : 'gray')}>
                                    {isDone ? '  ✔ ' : (isActive ? '  ▸ ' : '  ○ ')}
                                </Text>
                                <Text color={isActive ? '#00FFFF' : (isDone ? '#00FF7F' : 'gray')} bold={isActive}>
                                    {step.label}
                                </Text>
                            </Box>
                            {isActive && (
                                <Text color="gray" dimColor>    {step.desc}</Text>
                            )}
                        </Box>
                    );
                })}
            </Box>

            {/* Divider */}
            <Box marginY={1}><Text color="#2E8B8B">{'─'.repeat(22)}</Text></Box>

            <Text color="#00FFFF" bold>◈ HISTORY</Text>
            <Box marginTop={1} flexDirection="column">
                <Text color="gray" dimColor>  No prior sessions</Text>
            </Box>
        </Box>
    );
};

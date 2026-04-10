import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';

export const AgentContext = () => {
    const [pulse, setPulse] = useState(0);

    useEffect(() => {
        const t = setInterval(() => setPulse(p => (p + 1) % 4), 800);
        return () => clearInterval(t);
    }, []);

    const dots = '.'.repeat(pulse);
    const bar = (value: number, max: number, width: number) => {
        const filled = Math.round((value / max) * width);
        return '▓'.repeat(filled) + '░'.repeat(width - filled);
    };

    return (
        <Box flexDirection="column" width={32} borderStyle="round" borderColor="#2E8B8B" padding={1} marginRight={1}>
            {/* Session */}
            <Text color="#00FFFF" bold>◈ SESSION</Text>
            <Box marginTop={1} flexDirection="column">
                <Box>
                    <Text color="gray">  Status   </Text>
                    <Text color="#00FF7F">● active{dots}</Text>
                </Box>
                <Box>
                    <Text color="gray">  Model    </Text>
                    <Text color="#00FFFF">gemini-3.1-pro</Text>
                </Box>
                <Box>
                    <Text color="gray">  Mode     </Text>
                    <Text color="#20B2AA">autonomous</Text>
                </Box>
            </Box>

            {/* Divider */}
            <Box marginY={1}><Text color="#2E8B8B">{'─'.repeat(28)}</Text></Box>

            {/* Workspace */}
            <Text color="#00FFFF" bold>◈ WORKSPACE</Text>
            <Box marginTop={1} flexDirection="column">
                <Text color="#20B2AA">  ▸ src/index.tsx</Text>
                <Text color="white" dimColor>  ▸ src/agent.tsx</Text>
                <Text color="white" dimColor>  ▸ src/utils/helpers.ts</Text>
                <Text color="white" dimColor>  ▸ package.json</Text>
                <Text color="white" dimColor>  ▸ tsconfig.json</Text>
                <Text color="gray" dimColor>  + 3 more files</Text>
            </Box>

            {/* Divider */}
            <Box marginY={1}><Text color="#2E8B8B">{'─'.repeat(28)}</Text></Box>

            {/* Tools */}
            <Text color="#00FFFF" bold>◈ TOOLBOX</Text>
            <Box marginTop={1} flexDirection="column">
                <Text color="#00FF7F">  ● read_file</Text>
                <Text color="#00FF7F">  ● write_file</Text>
                <Text color="#00FF7F">  ● run_command</Text>
                <Text color="#00FF7F">  ● search_web</Text>
                <Text color="#00FF7F">  ● grep_search</Text>
                <Text color="#00FF7F">  ● list_dir</Text>
            </Box>

            {/* Divider */}
            <Box marginY={1}><Text color="#2E8B8B">{'─'.repeat(28)}</Text></Box>

            {/* Token usage */}
            <Text color="#00FFFF" bold>◈ RESOURCES</Text>
            <Box marginTop={1} flexDirection="column">
                <Text color="gray">  Tokens</Text>
                <Text color="#20B2AA">  {bar(2048, 128000, 20)}</Text>
                <Text color="gray" dimColor>  2,048 / 128,000</Text>
                <Box marginTop={1}/>
                <Text color="gray">  Context Limit</Text>
                <Text color="#00FFFF">  {bar(8, 50, 20)}</Text>
                <Text color="gray" dimColor>  8 files loaded</Text>
            </Box>
        </Box>
    );
};

import React from 'react';
import { render, Box, Text } from 'ink';
import { AgentHeader } from './components/AgentHeader.js';
import { AgentContext } from './components/AgentContext.js';
import { AgentCanvas } from './components/AgentCanvas.js';
import { AgentSteps } from './components/AgentSteps.js';

const App = () => {
  return (
    <Box flexDirection="column" padding={1} width="100%">
      <AgentHeader />

      <Box flexDirection="row" width="100%">
        <AgentContext />
        <AgentCanvas />
        <AgentSteps />
      </Box>

      {/* Footer */}
      <Box marginTop={1} paddingX={1} borderStyle="single" borderColor="#2E8B8B" borderBottom={false} borderLeft={false} borderRight={false}>
        <Box justifyContent="space-between" width="100%">
          <Text color="gray" dimColor>ctrl+c quit  │  type 'exit' to detach</Text>
          <Text color="#2E8B8B" dimColor>codetwin v5.0 · open-code architecture</Text>
        </Box>
      </Box>
    </Box>
  );
};

console.clear();
render(<App />);

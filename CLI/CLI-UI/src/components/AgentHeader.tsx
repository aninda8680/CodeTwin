import React from 'react';
import { Box, Text } from 'ink';

export const AgentHeader = () => {
  const lines = [
    `                        _ .-') _     ('-.   .-') _     (\`\\ .-') /\`            .-') _  `,
    `                       ( (  OO) )  _(  OO) (  OO) )     \`.(  OO ),'           ( OO ) ) `,
    `   .-----.  .-'),-----. \\     .'_ (,------./     '._ ,--./  .--.  ,-.-') ,--./ ,--,'  `,
    `  '  .--./ ( OO'  .-.  ',\`'--..._) |  .---'|'--...__)|      |  |  |  |OO)|   \\ |  |\\  `,
    `  |  |('-. /   |  | |  ||  |  \\  ' |  |    '--.  .--'|  |   |  |, |  |  \\|    \\|  | ) `,
    ` /_) |OO  )\\_) |  |\\|  ||  |   ' |(|  '--.    |  |   |  |.'.|  |_)|  |(_/|  .     |/  `,
    ` ||  |\`-'|   \\ |  | |  ||  |   / : |  .--'    |  |   |         | ,|  |_.'|  |\\    |   `,
    `(_'  '--'\\    \`'  '-'  '|  '--'  / |  \`---.   |  |   |   ,'.   |(_|  |   |  | \\   |   `,
    `   \`-----'      \`-----' \`-------'  \`------'   \`--'   '--'   '--'  \`--'   \`--'  \`--'   `,
  ];

  const colors = [
    '#006666', '#008080', '#009999', '#00AAAA',
    '#00BBBB', '#00CCCC', '#00DDDD', '#00EEEE', '#00FFFF',
  ];

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="column" paddingX={1}>
        {lines.map((line, i) => (
          <Text key={i} color={colors[i]}>{line}</Text>
        ))}
      </Box>
      <Box marginTop={1} paddingX={2} justifyContent="space-between">
        <Text color="#2E8B8B">autonomous code agent</Text>
        <Text color="gray">━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</Text>
        <Text color="#00FF7F"> ● online</Text>
      </Box>
    </Box>
  );
};

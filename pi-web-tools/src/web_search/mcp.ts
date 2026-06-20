import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export async function createMcpClient(
	url: string,
	headers: Record<string, string>,
): Promise<Client> {
	const transport = new StreamableHTTPClientTransport(new URL(url), {
		requestInit: { headers },
	});

	const client = new Client(
		{ name: "pi-web-tools", version: "0.3.0" },
		{ capabilities: {} },
	);

	await client.connect(transport);
	return client;
}

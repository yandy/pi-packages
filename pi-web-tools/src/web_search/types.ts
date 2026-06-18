export interface SearchSource {
	title: string;
	url: string;
	snippet: string;
}

export interface SearchResponse {
	answer: string;
	sources: SearchSource[];
	sourceLabel: string;
}

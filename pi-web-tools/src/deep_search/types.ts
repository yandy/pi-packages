export interface DeepSearchSource {
	title: string;
	url: string;
}

export interface DeepSearchResponse {
	answer: string;
	sources: DeepSearchSource[];
}

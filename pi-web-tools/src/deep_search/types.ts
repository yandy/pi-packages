export interface DeepSearchSource {
	title: string;
	url: string;
}

export interface DeepSearchResponse {
	answer: string;
	sources: DeepSearchSource[];
}

export interface DeepSearchOptions {
	enableSearchExtension?: boolean;
	freshness?: number;
	assignedSiteList?: string[];
	enableImageOutput?: boolean;
}

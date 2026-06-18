export interface ImageResult {
	index: number;
	title: string;
	url: string;
}

export interface ImageSearchResponse {
	answer: string;
	images: ImageResult[];
}

export interface ImageSearchParams {
	query?: string;
	imageUrl?: string;
}

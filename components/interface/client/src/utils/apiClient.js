const sanitizeBaseUrl = (url = "") => url.trim().replace(/\/$/, "");

const detectBaseUrl = () => {
    const envUrl = import.meta.env?.VITE_INTERFACE_API_URL;
    if (envUrl) {
        return sanitizeBaseUrl(envUrl);
    }

    if (typeof window !== "undefined") {
        if (window.__APP_CONFIG__?.apiBaseUrl) {
            return sanitizeBaseUrl(window.__APP_CONFIG__.apiBaseUrl);
        }

        if (window.location?.origin) {
            const { hostname, origin } = window.location;
            if (hostname === "localhost" || hostname === "127.0.0.1") {
                return "";
            }
            return sanitizeBaseUrl(origin);
        }
    }

    return "";
};

const API_BASE_URL = detectBaseUrl();

export const getApiBaseUrl = () => API_BASE_URL;

export const buildApiUrl = (path = "") => {
    if (!path) {
        return API_BASE_URL;
    }

    if (/^https?:\/\//i.test(path)) {
        return path;
    }

    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    if (!API_BASE_URL) {
        return normalizedPath;
    }

    return `${API_BASE_URL}${normalizedPath}`;
};

export const apiFetch = (path, options) => fetch(buildApiUrl(path), options);

export const apiEventSource = (path, init) => new EventSource(buildApiUrl(path), init);

import { getFirestore } from '../firestore.js';
import { v4 as uuidv4 } from 'uuid';

export class FirestoreStore {
    constructor() {
        this.db = getFirestore();
    }

    async ensureUser(userId) {
        if (!userId) return;
        const userRef = this.db.collection('users').doc(userId);
        const doc = await userRef.get();
        if (!doc.exists) {
            await userRef.set({
                id: userId,
                createdAt: new Date().toISOString(),
                lastSeen: new Date().toISOString()
            });
        } else {
            await userRef.update({
                lastSeen: new Date().toISOString()
            });
        }
    }

    async ensureSession({ sessionId, userId, projectId }) {
        if (!sessionId) return;
        const sessionRef = this.db.collection('sessions').doc(sessionId);
        const doc = await sessionRef.get();
        if (!doc.exists) {
            await sessionRef.set({
                id: sessionId,
                userId,
                projectId,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            });
        } else {
            await sessionRef.update({
                updatedAt: new Date().toISOString()
            });
        }
    }

    async updateSession(sessionId, data) {
        await this.db.collection('sessions').doc(sessionId).set(data, { merge: true });
    }


    async addMessage({ sessionId, role, content, tokenUsage = null }) {
        const message = {
            sessionId,
            role,
            content,
            tokenUsage,
            timestamp: new Date().toISOString()
        };

        // Add to subcollection for better organization and querying
        await this.db.collection('sessions').doc(sessionId).collection('messages').add(message);

        // Also update the session's updated_at (use set with merge to avoid errors if doc doesn't exist)
        await this.db.collection('sessions').doc(sessionId).set({
            updatedAt: new Date().toISOString(),
            lastMessage: content.substring(0, 100) // Preview
        }, { merge: true });
    }

    async getRecentMessages(sessionId, limit = 30) {
        const messagesRef = this.db.collection('sessions').doc(sessionId).collection('messages');
        const snapshot = await messagesRef
            .orderBy('timestamp', 'desc')
            .limit(limit)
            .get();

        const messages = [];
        snapshot.forEach(doc => {
            messages.push({ id: doc.id, ...doc.data() });
        });

        return messages.reverse(); // Return in chronological order
    }

    async getSessionSummary(sessionId) {
        const doc = await this.db.collection('sessions').doc(sessionId).get();
        return doc.exists ? doc.data().summary : null;
    }

    async setSessionSummary(sessionId, summary) {
        await this.db.collection('sessions').doc(sessionId).set({ summary }, { merge: true });
    }

    async countMessages(sessionId) {
        const snapshot = await this.db.collection('sessions').doc(sessionId).collection('messages').count().get();
        return snapshot.data().count;
    }

    async addToolRun({ sessionId, name, input, output, success }) {
        await this.db.collection('sessions').doc(sessionId).collection('tool_runs').add({
            name,
            input,
            output,
            success,
            timestamp: new Date().toISOString()
        });
    }

    async addMemory({ scope, key, text, meta }) {
        await this.db.collection('memories').add({
            scope,
            key,
            text,
            meta,
            timestamp: new Date().toISOString()
        });
    }

    async searchMemories({ scope, query, topK = 10 }) {
        // Basic keyword search (Firestore doesn't support full-text search natively without extensions)
        // For now, we'll just fetch recent memories for the scope.
        // In a real app, we'd use a vector store or Algolia/Elasticsearch.
        // This is a placeholder for the "search" functionality.

        try {
            const snapshot = await this.db.collection('memories')
                .where('scope', '==', scope)
                .orderBy('timestamp', 'desc')
                .limit(topK)
                .get();

            const memories = [];
            snapshot.forEach(doc => {
                const data = doc.data();
                if (data.text.toLowerCase().includes(query.toLowerCase())) {
                    memories.push({ id: doc.id, ...data });
                }
            });
            return memories;
        } catch (error) {
            // If index isn't ready yet, log and return empty array instead of crashing
            if (error.code === 9) {
                console.warn('Firestore index not ready yet for memories collection. Returning empty results.');
                return [];
            }
            throw error;
        }
    }

    // Placeholder for semantic search if we add vector support later
    async semanticSearch({ scope, query, topK }) {
        return this.searchMemories({ scope, query, topK });
    }

    // ============================================
    // ANALYTICS & EXPORT METHODS (Required by index.js)
    // ============================================

    async getStats() {
        const totalMessages = (await this.db.collection('sessions').get()).docs.reduce((acc, doc) => acc + (doc.data().messageCount || 0), 0); // Approximation or need subcollection count
        const totalSessions = (await this.db.collection('sessions').count().get()).data().count;
        const totalUsers = (await this.db.collection('users').count().get()).data().count;
        const totalToolRuns = 0; // Need to implement tool run counting across all sessions
        const totalMemories = (await this.db.collection('memories').count().get()).data().count;

        return {
            summary: {
                totalMessages,
                totalSessions,
                totalUsers,
                totalToolRuns,
                totalMemories,
                successRate: "0%" // Placeholder
            },
            tokens: { messagesWithTokens: 0, totalTokens: 0, averagePerMessage: 0 },
            recentActivity: { sessionsLast7Days: 0, messagesLast7Days: 0 },
            memoryBreakdown: {}
        };
    }

    async getSessionDetails(sessionId) {
        const doc = await this.db.collection('sessions').doc(sessionId).get();
        if (!doc.exists) return null;
        return { ...doc.data(), user_id: doc.data().userId, project_id: doc.data().projectId, summary_text: doc.data().summary };
    }

    async getSessionMessages(sessionId, limit = 1000) {
        const snapshot = await this.db.collection('sessions').doc(sessionId).collection('messages')
            .orderBy('timestamp', 'asc')
            .limit(limit)
            .get();

        return snapshot.docs.map(doc => ({
            role: doc.data().role,
            content: doc.data().content,
            created_at: doc.data().timestamp,
            token_usage_json: doc.data().tokenUsage ? JSON.stringify(doc.data().tokenUsage) : null
        }));
    }

    async getSessionToolRuns(sessionId) {
        const snapshot = await this.db.collection('sessions').doc(sessionId).collection('tool_runs')
            .orderBy('timestamp', 'asc')
            .get();

        return snapshot.docs.map(doc => ({
            name: doc.data().name,
            input_json: JSON.stringify(doc.data().input),
            output_json: JSON.stringify(doc.data().output),
            success: doc.data().success ? 1 : 0,
            created_at: doc.data().timestamp
        }));
    }

    async listSessions({ userId, limit = 50 }) {
        try {
            let ref = this.db.collection('sessions');
            if (userId) {
                ref = ref.where('userId', '==', userId);
            }
            const snapshot = await ref.orderBy('updatedAt', 'desc').limit(limit).get();

            return snapshot.docs.map(doc => ({
                id: doc.id,
                user_id: doc.data().userId,
                project_id: doc.data().projectId,
                created_at: doc.data().createdAt,
                updated_at: doc.data().updatedAt,
                summary_text: doc.data().summary,
                metadata: doc.data().metadata,  // Include metadata for frontend
                messageCount: 0 // Expensive to calculate for list
            }));
        } catch (error) {
            console.error("Firestore listSessions error:", error);
            throw error;
        }
    }

    // Batch embedding generation placeholder
    async getMemoriesWithoutEmbeddings(scope, limit) {
        // Placeholder: Firestore vector search setup is complex, skipping for now
        return [];
    }

    async getEmbeddingStatus() {
        const totalMemories = (await this.db.collection('memories').count().get()).data().count;
        // Assuming we store embeddings in a subcollection or separate collection
        // For now, return 0 coverage
        return {
            totalMemories,
            withEmbeddings: 0,
            withoutEmbeddings: totalMemories,
            coverage: "0%"
        };
    }

    async createCollaborationSession({ workflowId, participants }) {
        const sessionId = uuidv4();
        await this.db.collection('collaboration_sessions').doc(sessionId).set({
            workflowId,
            participants,
            createdAt: new Date().toISOString()
        });
        return sessionId;
    }

    async logCollaborationEvent({ sessionId, userId, eventType, eventData }) {
        await this.db.collection('collaboration_events').add({
            sessionId,
            userId,
            eventType,
            eventData,
            createdAt: new Date().toISOString()
        });
    }

    async getCollaborationEvents(sessionId) {
        const snapshot = await this.db.collection('collaboration_events')
            .where('sessionId', '==', sessionId)
            .orderBy('createdAt', 'desc')
            .limit(100)
            .get();

        return snapshot.docs.map(doc => doc.data());
    }
}


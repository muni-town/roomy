import { config } from "dotenv";

// Load .env file for integration tests
config();

// Also load from root if it exists
config({ path: "../../.env" });

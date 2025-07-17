import dotenv from 'dotenv';
import oracledb from 'oracledb';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import path from "path";

dotenv.config();

let walletPath = process.env.WALLET_PATH;
let walletPassword = process.env.WALLET_PASSWORD;
if(walletPath && walletPath.length>0) {
    walletPath = path.join(process.cwd(), path.normalize('./server/utils/db/wallet'));
}

const dbConfig =  {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    connectString: process.env.CONNECT_STRING,
    ...(walletPath && walletPath.length > 0 ? {
        configDir: walletPath,
        walletLocation: walletPath,
        walletPassword: walletPassword
    }:{})
};

let mleModuleName = process.env.MLE_MODULE;
let createdUserId = null;

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
oracledb.autoCommit = true;

async function executeSQLScript(script) {
    let connection;
    try {
        connection = await oracledb.getConnection(dbConfig);
        await connection.execute(script);
        console.log('Script executed successfully');
    } catch (err) {
        console.error('Error executing script:', err);
        throw err;
    } finally {
        if (connection) {
            try {
                await connection.close();
            } catch (err) {
                console.error('Error closing connection:', err);
            }
        }
    }
}

async function prepareDatabase() {
const createPackageSQL = `
CREATE OR REPLACE PACKAGE user_package AS
    FUNCTION newUserFunc(name IN VARCHAR2) RETURN NUMBER;
    FUNCTION getUser(id IN NUMBER) RETURN VARCHAR2;
    FUNCTION getAllUsers RETURN JSON;
    FUNCTION updateUser(id IN NUMBER, name IN VARCHAR2) RETURN NUMBER;
    FUNCTION deleteUser(id IN NUMBER) RETURN NUMBER;
END user_package;
`;

const createPackageBodySQL = `
CREATE OR REPLACE PACKAGE BODY user_package AS
    FUNCTION newUserFunc(name IN VARCHAR2) RETURN NUMBER
    AS MLE MODULE ${mleModuleName}
    SIGNATURE 'newUser(string)';
    
    FUNCTION getUser(id IN NUMBER) RETURN VARCHAR2
    AS MLE MODULE ${mleModuleName}
    SIGNATURE 'getUser(number)';
    
    FUNCTION getAllUsers RETURN JSON
    AS MLE MODULE ${mleModuleName}
    SIGNATURE 'getAllUsers()';
    
    FUNCTION updateUser(id IN NUMBER, name IN VARCHAR2) RETURN NUMBER
    AS MLE MODULE ${mleModuleName}
    SIGNATURE 'updateUser(number, string)';
    
    FUNCTION deleteUser(id IN NUMBER) RETURN NUMBER
    AS MLE MODULE ${mleModuleName}
    SIGNATURE 'deleteUser(number)';
END user_package;
`;

    try {
        console.log('Creating package...');
        await executeSQLScript(createPackageSQL);

        console.log('Creating package body...');
        await executeSQLScript(createPackageBodySQL);

        console.log('Successfully created package and package body');
    } catch (err) {
        console.error('Error during package creation:', err);
    }
}

async function cleanupDatabase() {
    const dropPackageSQL = `DROP PACKAGE user_package`;

    try {
        console.log('Dropping package...');
        await executeSQLScript(dropPackageSQL);
        console.log('Successfully dropped package');
    } catch (err) {
        console.error('Error during package drop:', err);
    }
}

async function executeSQLScriptWithOutput(plsql, binds = {}, options = {}) {
    let connection;
    try {
        connection = await oracledb.getConnection(dbConfig);
        const result = await connection.execute(plsql, binds, options);
        return result;
    } catch (err) {
        console.error('Error executing PL/SQL:', err);
        throw err;
    } finally {
        if (connection) {
        try {
            await connection.close();
        } catch (err) {
            console.error('Error closing connection:', err);
        }
        }
    }
}

beforeAll(async () => {
    await prepareDatabase();
});

afterAll(async () => {
    await cleanupDatabase();
});

describe('user_package', () => {
    it('should create a new user and return its ID', async () => {
        const plsql = `BEGIN :id := USER_PACKAGE.NEWUSERFUNC(:name); END;`;
        const binds = {
        name: 'John Doe',
        id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
        };

        const result = await executeSQLScriptWithOutput(plsql, binds);
        createdUserId = result.outBinds.id;

        console.log('New user created with ID:', createdUserId);
        expect(createdUserId).toBeTypeOf('number');
    });

    it('should get a user by ID', async () => {
        const plsql = `BEGIN :user := USER_PACKAGE.GETUSER(:id); END;`;
        const binds = {
        id: createdUserId,
        user: { dir: oracledb.BIND_OUT, type: oracledb.STRING },
        };

        const result = await executeSQLScriptWithOutput(plsql, binds);
        console.log('User:', result.outBinds.user);
        expect(result.outBinds.user).toBe('John Doe');
    });

    it('should get all users', async () => {
        // First create two users
        const binds1 = {
            name: 'Alice',
            id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER }
        };
        const r1 = await executeSQLScriptWithOutput(
            `BEGIN :id := USER_PACKAGE.NEWUSERFUNC(:name); END;`,
            binds1
        );

        const binds2 = {
            name: 'Bob',
            id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER }
        };
        const r2 = await executeSQLScriptWithOutput(
            `BEGIN :id := USER_PACKAGE.NEWUSERFUNC(:name); END;`,
            binds2
        );

        const plsql = `BEGIN :json := USER_PACKAGE.GETALLUSERS(); END;`;
        const binds = {
            json: { dir: oracledb.BIND_OUT, type: oracledb.DB_TYPE_JSON }
        };

        const result = await executeSQLScriptWithOutput(plsql, binds);
        const items = result.outBinds.json;

        expect(Array.isArray(items)).toBe(true);
        // // Expect at least the two recently created users
        const names = items.map(u => u.NAME);
        expect(names).toContain('Alice');
        expect(names).toContain('Bob');
    });

    it('should update a user by ID', async () => {
        const plsql = `BEGIN :affected := USER_PACKAGE.UPDATEUSER(:id, :name); END;`;
        const binds = { id: createdUserId, 
        name: 'Jane Doe',
        affected: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER }, };

        const result = await executeSQLScriptWithOutput(plsql, binds);
        console.log('User updated');
        expect(result.outBinds.affected).toBe(1);
    });

    it('should delete a user by ID', async () => {
        const plsql = `BEGIN :affected := USER_PACKAGE.DELETEUSER(:id); END;`;
        const binds = { id: createdUserId,
        affected: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER }, };

        const result = await executeSQLScriptWithOutput(plsql, binds);
        console.log('User deleted');
        expect(result.outBinds.affected).toBe(1);
    });
});

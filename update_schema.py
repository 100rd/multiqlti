import re
import os

schema_path = os.path.join(os.getcwd(), 'shared', 'schema.ts')
with open(schema_path, 'r', encoding='utf-8') as f:
    content = f.read()

new_tables = """
export const projects = pgTable("projects", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  description: text("description"),
  ownerId: text("owner_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const projectMembers = pgTable("project_members", {
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  role: text("role").notNull().default("editor"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.userId] }),
]);

export const insertProjectSchema = createInsertSchema(projects).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projects.$inferSelect;

"""

if 'export const projects = pgTable' not in content:
    users_table_index = content.find('export const users = pgTable')
    if users_table_index != -1:
        end_of_users_table = content.find('\n\n', users_table_index)
        content = content[:end_of_users_table + 2] + new_tables + content[end_of_users_table + 2:]

global_tables = ['users', 'sessions', 'projects', 'projectMembers', 'providerKeys']

table_regex = re.compile(r'export const (\w+) = pgTable\("([^"]+)",\s*\{')
matches = list(table_regex.finditer(content))

tables_to_update = []
for match in matches:
    js_name = match.group(1)
    if js_name not in global_tables and not js_name.endswith('Relations') and not js_name.endswith('Schema'):
        tables_to_update.append({
            'js_name': js_name,
            'pg_name': match.group(2),
            'index': match.end()
        })

print(f"Found {len(tables_to_update)} tables to update.")

project_id_field = '\n  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),'

for table in reversed(tables_to_update):
    table_end = content.find('});', table['index'])
    table_body = content[table['index']:table_end]
    
    if 'projectId:' not in table_body and 'project_id' not in table_body:
        content = content[:table['index']] + project_id_field + content[table['index']:]
        print(f"Added projectId to {table['js_name']}")

with open(schema_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Done.")

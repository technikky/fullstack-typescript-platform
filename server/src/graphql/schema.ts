/**
 * The GraphQL surface, over the same services the REST routes call.
 *
 * The point of having both is not that GraphQL is nicer. It is that **two transports over one
 * domain is where authorization bugs live.** The usual shape of the bug: a REST route checks a
 * role, the resolver over the same data does not, and the GraphQL endpoint becomes a documented
 * way around the permission system. It is easy to write and hard to notice, because both
 * surfaces work.
 *
 * The defence here is structural: resolvers hold no authorization logic at all. They unwrap
 * arguments, call the same service method the REST handler calls, and map errors. The service
 * resolves the actor's role from the database and calls `authorize`. A parity test then asserts,
 * for a table of (actor, action) pairs, that both surfaces reach the same decision -- so a future
 * resolver that starts doing its own checks fails the suite.
 *
 * Written with `graphql-js` and a hand-built context rather than a server framework: the
 * interesting behaviour is the resolver-to-service boundary, and a framework would add a schema
 * DSL, a plugin system and a lifecycle to learn without changing what is being demonstrated.
 */

import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
} from "graphql";

import { ITEM_STATUSES } from "../domain/types.js";
import { ROLES } from "../authz/policy.js";
import { unauthenticated } from "../errors.js";
import type { EventBuffer } from "../domain/events.js";
import type { AccountService } from "../domain/accounts.js";
import type { WorkService } from "../domain/work.js";
import type { WorkspaceService } from "../domain/workspaces.js";

export interface GraphQLContext {
  readonly userId: string | null;
  readonly accounts: AccountService;
  readonly workspaces: WorkspaceService;
  readonly work: WorkService;
  readonly events: EventBuffer;
}

/**
 * Every mutation and every non-public query starts here.
 *
 * A resolver that forgets it is a resolver that returns another user's data, so the unwrapping
 * is one function rather than a repeated `if`.
 */
const requireUser = (context: GraphQLContext): string => {
  if (context.userId === null) throw unauthenticated();
  return context.userId;
};

const RoleEnum = new GraphQLEnumType({
  name: "Role",
  values: Object.fromEntries(ROLES.map((role) => [role.toUpperCase(), { value: role }])),
});

const ItemStatusEnum = new GraphQLEnumType({
  name: "ItemStatus",
  values: Object.fromEntries(
    ITEM_STATUSES.map((status) => [status.toUpperCase(), { value: status }]),
  ),
});

const UserType = new GraphQLObjectType({
  name: "User",
  // No `passwordHash` field exists, so no resolver can expose it even by accident. That is the
  // schema doing work the type system alone would not: both are strings.
  fields: {
    id: { type: new GraphQLNonNull(GraphQLString) },
    email: { type: new GraphQLNonNull(GraphQLString) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    createdAt: { type: new GraphQLNonNull(GraphQLString) },
  },
});

const WorkspaceType = new GraphQLObjectType({
  name: "Workspace",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLString) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    slug: { type: new GraphQLNonNull(GraphQLString) },
    createdBy: { type: new GraphQLNonNull(GraphQLString) },
    createdAt: { type: new GraphQLNonNull(GraphQLString) },
  },
});

const MemberType = new GraphQLObjectType({
  name: "Member",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLString) },
    userId: { type: new GraphQLNonNull(GraphQLString) },
    workspaceId: { type: new GraphQLNonNull(GraphQLString) },
    email: { type: new GraphQLNonNull(GraphQLString) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    role: { type: new GraphQLNonNull(RoleEnum) },
    createdAt: { type: new GraphQLNonNull(GraphQLString) },
  },
});

const BoardType = new GraphQLObjectType({
  name: "Board",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLString) },
    workspaceId: { type: new GraphQLNonNull(GraphQLString) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    createdBy: { type: new GraphQLNonNull(GraphQLString) },
    createdAt: { type: new GraphQLNonNull(GraphQLString) },
  },
});

const ItemType = new GraphQLObjectType({
  name: "Item",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLString) },
    boardId: { type: new GraphQLNonNull(GraphQLString) },
    title: { type: new GraphQLNonNull(GraphQLString) },
    body: { type: new GraphQLNonNull(GraphQLString) },
    status: { type: new GraphQLNonNull(ItemStatusEnum) },
    assigneeId: { type: GraphQLString },
    // Exposed because a client cannot do an optimistic update without it: the next mutation has
    // to send back the version it saw.
    version: { type: new GraphQLNonNull(GraphQLInt) },
    createdBy: { type: new GraphQLNonNull(GraphQLString) },
    createdAt: { type: new GraphQLNonNull(GraphQLString) },
    updatedAt: { type: new GraphQLNonNull(GraphQLString) },
  },
});

const CommentType = new GraphQLObjectType({
  name: "Comment",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLString) },
    itemId: { type: new GraphQLNonNull(GraphQLString) },
    authorId: { type: new GraphQLNonNull(GraphQLString) },
    body: { type: new GraphQLNonNull(GraphQLString) },
    createdAt: { type: new GraphQLNonNull(GraphQLString) },
  },
});

const ItemPageType = new GraphQLObjectType({
  name: "ItemPage",
  fields: {
    items: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(ItemType))) },
    nextCursor: { type: GraphQLString },
  },
});

const WorkspaceViewType = new GraphQLObjectType({
  name: "WorkspaceView",
  fields: {
    workspace: { type: new GraphQLNonNull(WorkspaceType) },
    role: { type: new GraphQLNonNull(RoleEnum) },
    /**
     * The actor's permissions, sent so a client can render its UI truthfully.
     *
     * Advisory only. The server does not trust it back, and a test calls a forbidden mutation
     * directly to prove the UI gate is cosmetic.
     */
    permissions: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
  },
});

const AuditEntryType = new GraphQLObjectType({
  name: "AuditEntry",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLString) },
    workspaceId: { type: GraphQLString },
    actorId: { type: GraphQLString },
    action: { type: new GraphQLNonNull(GraphQLString) },
    subject: { type: GraphQLString },
    at: { type: new GraphQLNonNull(GraphQLString) },
  },
});

/**
 * Top-level query fields are **nullable**; mutation fields are not.
 *
 * This is not an oversight, and it was a bug first. GraphQL propagates a field error up to the
 * nearest nullable ancestor, so a non-null top-level field that errors nulls the entire `data`
 * object. With `workspace` declared non-null, the query
 * `{ me { id } workspace(id: "...") { role } }` from someone who is not a member returned
 * `data: null` -- discarding `me`, which had resolved perfectly well. A client asking for two
 * things loses both because it was not allowed one.
 *
 * Nullable query fields give the partial result GraphQL is supposed to provide. Mutations keep
 * their non-null returns for the opposite reason: a mutation either happened or it errored, there
 * is no partial success to preserve, and a nullable return would force every caller to null-check
 * a success. List *elements* stay non-null in both cases -- a list containing nulls is a shape no
 * caller wants to handle.
 */
const QueryType = new GraphQLObjectType<unknown, GraphQLContext>({
  name: "Query",
  fields: {
    me: {
      type: UserType,
      resolve: (_source, _args, context) =>
        context.userId === null ? null : context.accounts.byId(context.userId),
    },
    workspaces: {
      type: new GraphQLList(new GraphQLNonNull(WorkspaceViewType)),
      resolve: (_source, _args, context) => context.workspaces.listFor(requireUser(context)),
    },
    workspace: {
      type: WorkspaceViewType,
      args: { id: { type: new GraphQLNonNull(GraphQLString) } },
      resolve: (_source, args: { id: string }, context) =>
        context.workspaces.view(args.id, requireUser(context)),
    },
    members: {
      type: new GraphQLList(new GraphQLNonNull(MemberType)),
      args: { workspaceId: { type: new GraphQLNonNull(GraphQLString) } },
      resolve: (_source, args: { workspaceId: string }, context) =>
        context.workspaces.members(args.workspaceId, requireUser(context)),
    },
    boards: {
      type: new GraphQLList(new GraphQLNonNull(BoardType)),
      args: { workspaceId: { type: new GraphQLNonNull(GraphQLString) } },
      resolve: (_source, args: { workspaceId: string }, context) =>
        context.work.listBoards(args.workspaceId, requireUser(context)),
    },
    board: {
      type: BoardType,
      args: { id: { type: new GraphQLNonNull(GraphQLString) } },
      resolve: (_source, args: { id: string }, context) =>
        context.work.getBoard(args.id, requireUser(context)),
    },
    items: {
      type: ItemPageType,
      args: {
        boardId: { type: new GraphQLNonNull(GraphQLString) },
        limit: { type: GraphQLInt },
        after: { type: GraphQLString },
        status: { type: ItemStatusEnum },
      },
      resolve: (
        _source,
        args: { boardId: string; limit?: number; after?: string; status?: (typeof ITEM_STATUSES)[number] },
        context,
      ) =>
        context.work.listItems(args.boardId, requireUser(context), {
          ...(args.limit === undefined ? {} : { limit: args.limit }),
          ...(args.after === undefined ? {} : { after: args.after }),
          ...(args.status === undefined ? {} : { status: args.status }),
        }),
    },
    item: {
      type: ItemType,
      args: { id: { type: new GraphQLNonNull(GraphQLString) } },
      resolve: (_source, args: { id: string }, context) =>
        context.work.getItem(args.id, requireUser(context)),
    },
    comments: {
      type: new GraphQLList(new GraphQLNonNull(CommentType)),
      args: { itemId: { type: new GraphQLNonNull(GraphQLString) } },
      resolve: (_source, args: { itemId: string }, context) =>
        context.work.listComments(args.itemId, requireUser(context)),
    },
    auditTrail: {
      type: new GraphQLList(new GraphQLNonNull(AuditEntryType)),
      args: {
        workspaceId: { type: new GraphQLNonNull(GraphQLString) },
        limit: { type: GraphQLInt },
      },
      resolve: (_source, args: { workspaceId: string; limit?: number }, context) =>
        context.workspaces.auditTrail(args.workspaceId, requireUser(context), args.limit ?? 50),
    },
  },
});

const MutationType = new GraphQLObjectType<unknown, GraphQLContext>({
  name: "Mutation",
  fields: {
    createWorkspace: {
      type: new GraphQLNonNull(WorkspaceViewType),
      args: { name: { type: new GraphQLNonNull(GraphQLString) } },
      resolve: (_source, args: { name: string }, context) =>
        context.workspaces.create(requireUser(context), args.name),
    },
    renameWorkspace: {
      type: new GraphQLNonNull(WorkspaceType),
      args: {
        id: { type: new GraphQLNonNull(GraphQLString) },
        name: { type: new GraphQLNonNull(GraphQLString) },
      },
      resolve: (_source, args: { id: string; name: string }, context) =>
        context.workspaces.rename(args.id, requireUser(context), args.name, context.events),
    },
    deleteWorkspace: {
      type: new GraphQLNonNull(GraphQLBoolean),
      args: { id: { type: new GraphQLNonNull(GraphQLString) } },
      resolve: async (_source, args: { id: string }, context) => {
        await context.workspaces.remove(args.id, requireUser(context));
        return true;
      },
    },
    addMember: {
      type: new GraphQLNonNull(MemberType),
      args: {
        workspaceId: { type: new GraphQLNonNull(GraphQLString) },
        userId: { type: new GraphQLNonNull(GraphQLString) },
        role: { type: new GraphQLNonNull(RoleEnum) },
      },
      resolve: async (
        _source,
        args: { workspaceId: string; userId: string; role: (typeof ROLES)[number] },
        context,
      ) => {
        const actorId = requireUser(context);
        const membership = await context.workspaces.addMember(
          args.workspaceId,
          actorId,
          args.userId,
          args.role,
          context.events,
        );
        // The Member type carries the user's email and name; the service returns the membership,
        // so the two are joined here rather than by widening the service's return type for one
        // transport's convenience.
        const user = await context.accounts.byId(args.userId);
        return { ...membership, email: user?.email ?? "", name: user?.name ?? "" };
      },
    },
    changeMemberRole: {
      type: new GraphQLNonNull(MemberType),
      args: {
        workspaceId: { type: new GraphQLNonNull(GraphQLString) },
        userId: { type: new GraphQLNonNull(GraphQLString) },
        role: { type: new GraphQLNonNull(RoleEnum) },
      },
      resolve: async (
        _source,
        args: { workspaceId: string; userId: string; role: (typeof ROLES)[number] },
        context,
      ) => {
        const membership = await context.workspaces.changeRole(
          args.workspaceId,
          requireUser(context),
          args.userId,
          args.role,
          context.events,
        );
        const user = await context.accounts.byId(args.userId);
        return { ...membership, email: user?.email ?? "", name: user?.name ?? "" };
      },
    },
    removeMember: {
      type: new GraphQLNonNull(GraphQLBoolean),
      args: {
        workspaceId: { type: new GraphQLNonNull(GraphQLString) },
        userId: { type: new GraphQLNonNull(GraphQLString) },
      },
      resolve: async (_source, args: { workspaceId: string; userId: string }, context) => {
        await context.workspaces.removeMember(
          args.workspaceId,
          requireUser(context),
          args.userId,
          context.events,
        );
        return true;
      },
    },
    createBoard: {
      type: new GraphQLNonNull(BoardType),
      args: {
        workspaceId: { type: new GraphQLNonNull(GraphQLString) },
        name: { type: new GraphQLNonNull(GraphQLString) },
      },
      resolve: (_source, args: { workspaceId: string; name: string }, context) =>
        context.work.createBoard(args.workspaceId, requireUser(context), args.name, context.events),
    },
    renameBoard: {
      type: new GraphQLNonNull(BoardType),
      args: {
        id: { type: new GraphQLNonNull(GraphQLString) },
        name: { type: new GraphQLNonNull(GraphQLString) },
      },
      resolve: (_source, args: { id: string; name: string }, context) =>
        context.work.renameBoard(args.id, requireUser(context), args.name, context.events),
    },
    deleteBoard: {
      type: new GraphQLNonNull(GraphQLBoolean),
      args: { id: { type: new GraphQLNonNull(GraphQLString) } },
      resolve: async (_source, args: { id: string }, context) => {
        await context.work.deleteBoard(args.id, requireUser(context), context.events);
        return true;
      },
    },
    createItem: {
      type: new GraphQLNonNull(ItemType),
      args: {
        boardId: { type: new GraphQLNonNull(GraphQLString) },
        title: { type: new GraphQLNonNull(GraphQLString) },
        body: { type: GraphQLString },
        status: { type: ItemStatusEnum },
        assigneeId: { type: GraphQLString },
      },
      resolve: (
        _source,
        args: {
          boardId: string;
          title: string;
          body?: string;
          status?: (typeof ITEM_STATUSES)[number];
          assigneeId?: string | null;
        },
        context,
      ) =>
        context.work.createItem(
          args.boardId,
          requireUser(context),
          {
            title: args.title,
            ...(args.body === undefined ? {} : { body: args.body }),
            ...(args.status === undefined ? {} : { status: args.status }),
            ...(args.assigneeId === undefined ? {} : { assigneeId: args.assigneeId }),
          },
          context.events,
        ),
    },
    updateItem: {
      type: new GraphQLNonNull(ItemType),
      args: {
        id: { type: new GraphQLNonNull(GraphQLString) },
        // Required, exactly as in REST. An optional version would make the blind write the
        // easy path, and the two surfaces would disagree about whether concurrency is checked.
        expectedVersion: { type: new GraphQLNonNull(GraphQLInt) },
        title: { type: GraphQLString },
        body: { type: GraphQLString },
        status: { type: ItemStatusEnum },
        assigneeId: { type: GraphQLString },
      },
      resolve: (
        _source,
        args: {
          id: string;
          expectedVersion: number;
          title?: string;
          body?: string;
          status?: (typeof ITEM_STATUSES)[number];
          assigneeId?: string | null;
        },
        context,
      ) =>
        context.work.updateItem(
          args.id,
          requireUser(context),
          {
            expectedVersion: args.expectedVersion,
            ...(args.title === undefined ? {} : { title: args.title }),
            ...(args.body === undefined ? {} : { body: args.body }),
            ...(args.status === undefined ? {} : { status: args.status }),
            ...(args.assigneeId === undefined ? {} : { assigneeId: args.assigneeId }),
          },
          context.events,
        ),
    },
    deleteItem: {
      type: new GraphQLNonNull(GraphQLBoolean),
      args: { id: { type: new GraphQLNonNull(GraphQLString) } },
      resolve: async (_source, args: { id: string }, context) => {
        await context.work.deleteItem(args.id, requireUser(context), context.events);
        return true;
      },
    },
    addComment: {
      type: new GraphQLNonNull(CommentType),
      args: {
        itemId: { type: new GraphQLNonNull(GraphQLString) },
        body: { type: new GraphQLNonNull(GraphQLString) },
      },
      resolve: (_source, args: { itemId: string; body: string }, context) =>
        context.work.addComment(args.itemId, requireUser(context), args.body, context.events),
    },
    deleteComment: {
      type: new GraphQLNonNull(GraphQLBoolean),
      args: { id: { type: new GraphQLNonNull(GraphQLString) } },
      resolve: async (_source, args: { id: string }, context) => {
        await context.work.deleteComment(args.id, requireUser(context), context.events);
        return true;
      },
    },
  },
});

export const schema = new GraphQLSchema({ query: QueryType, mutation: MutationType });

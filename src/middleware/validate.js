// Validates req.body / req.query / req.params using a Zod schema.
// Usage: router.post('/x', validate({ body: schema }), handler)

function validate(schemas) {
    return (req, _res, next) => {
        try {
            if (schemas.body)   req.body   = schemas.body.parse(req.body);
            if (schemas.query)  req.query  = schemas.query.parse(req.query);
            if (schemas.params) req.params = schemas.params.parse(req.params);
            next();
        } catch (err) {
            next(err);
        }
    };
}

module.exports = validate;

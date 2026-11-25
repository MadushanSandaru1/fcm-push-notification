CREATE OR REPLACE PROCEDURE fin_user.prc_u37_unsubscribe(
    IN  p_login_id      integer,
    IN  p_org_id        integer,
    IN  p_device_id     varchar,
    OUT p_status        integer,
    OUT p_error_message text
)
LANGUAGE plpgsql
AS $$
BEGIN
    p_status := 0;
    p_error_message := NULL;

    IF p_login_id IS NULL OR p_org_id IS NULL
       OR p_device_id IS NULL OR btrim(p_device_id) = '' THEN
        RAISE EXCEPTION 'Login ID, organization ID, and device ID are required';
    END IF;

    UPDATE fin_user.u37_push_notification_devices
    SET u37_c01_app_status_id = 12,
        u37_c01_status_id = 2,
        u37_token = NULL,
        u37_u01_updated_by_id = 0,
        u37_updated_date = LOCALTIMESTAMP
    WHERE u37_u09_login_id = p_login_id
      AND u37_m01_org_id = p_org_id
      AND u37_devide_id = p_device_id;

    IF NOT FOUND THEN
        p_error_message := 'No matching push notification device found';
        RETURN;
    END IF;

    p_status := 1;
EXCEPTION
    WHEN OTHERS THEN
        p_status := 0;
        p_error_message := SQLSTATE || ': ' || SQLERRM;
END;
$$;

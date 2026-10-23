import esphome.codegen as cg
import esphome.config_validation as cv
from esphome import automation
from esphome.const import CONF_ID, CONF_ON_JSON_MESSAGE, CONF_ON_MESSAGE, CONF_QOS, CONF_TOPIC, CONF_TRIGGER_ID

DEPENDENCIES = ["mqtt"]
AUTO_LOAD = ["mqtt"]

panel_mqtt_ns = cg.esphome_ns.namespace("panel_mqtt")
PanelMqttComponent = panel_mqtt_ns.class_("PanelMqttComponent", cg.Component)
DynamicMqttJsonMessageTrigger = panel_mqtt_ns.class_(
    "DynamicMqttJsonMessageTrigger", automation.Trigger.template(cg.JsonObjectConst), cg.Component
)
DynamicMqttMessageTrigger = panel_mqtt_ns.class_(
    "DynamicMqttMessageTrigger", automation.Trigger.template(cg.std_string), cg.Component
)

CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(CONF_ID): cv.declare_id(PanelMqttComponent),
        cv.Optional(CONF_ON_JSON_MESSAGE): automation.validate_automation(
            {
                cv.GenerateID(CONF_TRIGGER_ID): cv.declare_id(DynamicMqttJsonMessageTrigger),
                cv.Required(CONF_TOPIC): cv.string,
                cv.Optional(CONF_QOS, default=0): cv.mqtt_qos,
            }
        ),
        cv.Optional(CONF_ON_MESSAGE): automation.validate_automation(
            {
                cv.GenerateID(CONF_TRIGGER_ID): cv.declare_id(DynamicMqttMessageTrigger),
                cv.Required(CONF_TOPIC): cv.string,
                cv.Optional(CONF_QOS, default=0): cv.mqtt_qos,
            }
        ),
    }
).extend(cv.COMPONENT_SCHEMA)


async def to_code(config):
    component = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(component, config)

    for conf in config.get(CONF_ON_JSON_MESSAGE, []):
        trigger = cg.new_Pvariable(conf[CONF_TRIGGER_ID], conf[CONF_TOPIC], conf[CONF_QOS])
        await cg.register_component(trigger, conf)
        await automation.build_automation(trigger, [(cg.JsonObjectConst, "x")], conf)

    for conf in config.get(CONF_ON_MESSAGE, []):
        trigger = cg.new_Pvariable(conf[CONF_TRIGGER_ID], conf[CONF_TOPIC], conf[CONF_QOS])
        await cg.register_component(trigger, conf)
        await automation.build_automation(trigger, [(cg.std_string, "x")], conf)
